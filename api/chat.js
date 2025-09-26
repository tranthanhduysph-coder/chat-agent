import OpenAI from 'openai';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const assistantId = process.env.ASSISTANT_ID;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const { action, userMessage, threadId } = req.body;

    if (action === 'create_thread') {
      const thread = await openai.beta.threads.create();
      return res.status(200).json({ threadId: thread.id });
    } 
    
    else if (action === 'send_message') {
      if (!threadId || !userMessage) {
        return res.status(400).json({ error: 'Missing threadId or userMessage' });
      }

      await openai.beta.threads.messages.create(threadId, {
        role: 'user',
        content: userMessage,
      });

      const run = await openai.beta.threads.runs.create(threadId, {
        assistant_id: assistantId,
      });

      let runStatus;
      do {
        await new Promise(resolve => setTimeout(resolve, 1000));
        runStatus = await openai.beta.threads.runs.retrieve(threadId, run.id);

        // PHẦN MỚI: Xử lý khi Trợ lý yêu cầu dùng công cụ
        if (runStatus.status === 'requires_action') {
            // Trong ví dụ này, chúng ta không thực sự chạy công cụ nào cả.
            // Chúng ta chỉ gửi lại một danh sách kết quả rỗng để báo cho Trợ lý biết
            // là công cụ đã "chạy xong" và nó có thể tiếp tục công việc.
            await openai.beta.threads.runs.submitToolOutputs(threadId, run.id, {
                tool_outputs: [], // Báo là không có kết quả từ công cụ
            });
        }

      } while (runStatus.status === 'in_progress' || runStatus.status === 'queued' || runStatus.status === 'requires_action');

      if (runStatus.status !== 'completed') {
        throw new Error(`Run failed with status: ${runStatus.status}`);
      }

      const messages = await openai.beta.threads.messages.list(threadId);
      const assistantResponse = messages.data.find(m => m.role === 'assistant');
      const responseText = assistantResponse.content[0].type === 'text' 
        ? assistantResponse.content[0].text.value 
        : "Không nhận được phản hồi dạng văn bản.";

      return res.status(200).json({ reply: responseText });
    }

    return res.status(400).json({ error: 'Invalid action' });

  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: error.message });
  }
}

