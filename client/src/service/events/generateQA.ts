import { TrainingData } from '@/service/mongo';
import { pushQABill } from '@/service/events/pushBill';
import { pushDataToKb } from '@/pages/api/openapi/kb/pushData';
import { TrainingModeEnum } from '@/constants/plugin';
import { ERROR_ENUM } from '../errorCode';
import { sendInform } from '@/pages/api/user/inform/send';
import { authBalanceByUid } from '../utils/auth';
import { axiosConfig, getAIChatApi } from '../lib/openai';
import { ChatCompletionRequestMessage } from 'openai';
import { gptMessage2ChatType } from '@/utils/adapt';
import { addLog } from '../utils/tools';
import { splitText2Chunks } from '@/utils/file';
import { countMessagesTokens } from '@/utils/common/tiktoken';
import { replaceVariable } from '@/utils/common/tools/text';
import { Prompt_AgentQA } from '@/prompts/core/agent';

const reduceQueue = () => {
  global.qaQueueLen = global.qaQueueLen > 0 ? global.qaQueueLen - 1 : 0;
};

export async function generateQA(): Promise<any> {
  if (global.qaQueueLen >= global.systemEnv.qaMaxProcess) return;
  global.qaQueueLen++;

  let trainingId = '';
  let userId = '';

  try {
    const data = await TrainingData.findOneAndUpdate(
      {
        mode: TrainingModeEnum.qa,
        lockTime: { $lte: new Date(Date.now() - 4 * 60 * 1000) }
      },
      {
        lockTime: new Date()
      }
    ).select({
      _id: 1,
      userId: 1,
      kbId: 1,
      prompt: 1,
      q: 1,
      source: 1,
      file_id: 1
    });

    // task preemption
    if (!data) {
      reduceQueue();
      global.qaQueueLen <= 0 && console.log(`【QA】任务完成`);
      return;
    }

    trainingId = data._id;
    userId = String(data.userId);
    const kbId = String(data.kbId);

    await authBalanceByUid(userId);

    const startTime = Date.now();

    const chatAPI = getAIChatApi();

    // 请求 chatgpt 获取回答
    const response = await Promise.all(
      [data.q].map((text) => {
        const messages: ChatCompletionRequestMessage[] = [
          {
            role: 'user',
            content: data.prompt
              ? replaceVariable(data.prompt, { text })
              : replaceVariable(Prompt_AgentQA.prompt, {
                  theme: Prompt_AgentQA.defaultTheme,
                  text
                })
          }
        ];
        const modelTokenLimit = global.qaModel.maxToken || 16000;
        const promptsToken = countMessagesTokens({
          messages: gptMessage2ChatType(messages)
        });
        const maxToken = modelTokenLimit - promptsToken;

        return chatAPI
          .createChatCompletion(
            {
              model: global.qaModel.model,
              temperature: 0.01,
              messages,
              stream: false,
              max_tokens: maxToken
            },
            {
              timeout: 480000,
              ...axiosConfig()
            }
          )
          .then((res) => {
            const answer = res.data.choices?.[0].message?.content;
            const totalTokens = res.data.usage?.total_tokens || 0;

            const result = formatSplitText(answer || ''); // 格式化后的QA对
            console.log(`split result length: `, result.length);
            // 计费
            if (result.length > 0) {
              pushQABill({
                userId: data.userId,
                totalTokens,
                appName: 'QA 拆分'
              });
            } else {
              addLog.info(`QA result 0:`, { answer });
            }

            return {
              rawContent: answer,
              result
            };
          })
          .catch((err) => {
            console.log('QA拆分错误');
            console.log(err.response?.status, err.response?.statusText, err.response?.data);
            return Promise.reject(err);
          });
      })
    );

    const responseList = response.map((item) => item.result).flat();

    // 创建 向量生成 队列
    await pushDataToKb({
      kbId,
      data: responseList.map((item) => ({
        ...item,
        source: data.source,
        file_id: data.file_id
      })),
      userId,
      mode: TrainingModeEnum.index
    });

    // delete data from training
    await TrainingData.findByIdAndDelete(data._id);

    console.log('生成QA成功，time:', `${(Date.now() - startTime) / 1000}s`);

    reduceQueue();
    generateQA();
  } catch (err: any) {
    reduceQueue();
    // log
    if (err?.response) {
      console.log('openai error: 生成QA错误');
      console.log(err.response?.status, err.response?.statusText, err.response?.data);
    } else {
      addLog.error('生成 QA 错误', err);
    }

    // message error or openai account error
    if (err?.message === 'invalid message format') {
      await TrainingData.findByIdAndRemove(trainingId);
    }

    // 账号余额不足，删除任务
    if (userId && err === ERROR_ENUM.insufficientQuota) {
      sendInform({
        type: 'system',
        title: 'QA 任务中止',
        content:
          '由于账号余额不足，索引生成任务中止，重新充值后将会继续。暂停的任务将在 7 天后被删除。',
        userId
      });
      console.log('余额不足，暂停向量生成任务');
      await TrainingData.updateMany(
        {
          userId
        },
        {
          lockTime: new Date('2999/5/5')
        }
      );
      return generateQA();
    }

    setTimeout(() => {
      generateQA();
    }, 1000);
  }
}

/**
 * 检查文本是否按格式返回
 */
function formatSplitText(text: string) {
  text = text.replace(/\\n/g, '\n'); // 将换行符替换为空格
  const regex = /Q\d+:(\s*)(.*)(\s*)A\d+:(\s*)([\s\S]*?)(?=Q|$)/g; // 匹配Q和A的正则表达式
  const matches = text.matchAll(regex); // 获取所有匹配到的结果

  const result = []; // 存储最终的结果
  for (const match of matches) {
    const q = match[2];
    const a = match[5];
    if (q && a) {
      // 如果Q和A都存在，就将其添加到结果中
      result.push({
        q: `${q}\n${a.trim().replace(/\n\s*/g, '\n')}`,
        a: ''
      });
    }
  }

  // empty result. direct split chunk
  if (result.length === 0) {
    const splitRes = splitText2Chunks({ text: text, maxLen: 500 });
    splitRes.chunks.forEach((item) => {
      result.push({
        q: item,
        a: ''
      });
    });
  }

  return result;
}
