// Import thư viện OpenAI
import OpenAI from 'openai';

// Khởi tạo OpenAI client. API Key sẽ được lấy từ biến môi trường trên Vercel
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const assistantId = process.env.ASSISTANT_ID;

// Hàm chính xử lý yêu cầu từ Frontend
export default async function handler(req, res) {
  // Chỉ cho phép phương thức POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const { action, userMessage, threadId } = req.body;

    // Dựa vào 'action' để biết frontend muốn làm gì
    if (action === 'create_thread') {
      const thread = await openai.beta.threads.create();
      return res.status(200).json({ threadId: thread.id });
    } 
    
    else if (action === 'send_message') {
      if (!threadId || !userMessage) {
        return res.status(400).json({ error: 'Missing threadId or userMessage' });
      }

      // 1. Thêm tin nhắn của người dùng vào luồng
      await openai.beta.threads.messages.create(threadId, {
        role: 'user',
        content: userMessage,
      });

      // 2. Chạy Trợ lý để xử lý luồng
      const run = await openai.beta.threads.runs.create(threadId, {
        assistant_id: assistantId,
      });

      // 3. Chờ cho đến khi Trợ lý xử lý xong
      let runStatus;
      do {
        await new Promise(resolve => setTimeout(resolve, 1000)); // Đợi 1 giây
        runStatus = await openai.beta.threads.runs.retrieve(threadId, run.id);
      } while (runStatus.status === 'in_progress' || runStatus.status === 'queued');

      if (runStatus.status !== 'completed') {
        throw new Error(`Run failed with status: ${runStatus.status}`);
      }

      // 4. Lấy danh sách tin nhắn trong luồng
      const messages = await openai.beta.threads.messages.list(threadId);
      
      // 5. Tìm tin nhắn trả lời mới nhất của Trợ lý
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
