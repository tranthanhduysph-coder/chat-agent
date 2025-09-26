import OpenAI from 'openai';
import { JWT } from 'google-auth-library';
import { GoogleSpreadsheet } from 'google-spreadsheet';

// --- Cấu hình Google Sheets ---
const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID;
// Lấy credentials từ biến môi trường (sẽ được mã hóa base64)
const serviceAccountAuth = new JWT({
  email: JSON.parse(Buffer.from(process.env.GOOGLE_SERVICE_ACCOUNT_BASE64, 'base64').toString('utf-8')).client_email,
  key: JSON.parse(Buffer.from(process.env.GOOGLE_SERVICE_ACCOUNT_BASE64, 'base64').toString('utf-8')).private_key,
  scopes: ['[https://www.googleapis.com/auth/spreadsheets](https://www.googleapis.com/auth/spreadsheets)'],
});
const doc = new GoogleSpreadsheet(GOOGLE_SHEET_ID, serviceAccountAuth);
// --- Kết thúc cấu hình Google Sheets ---

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const assistantId = process.env.ASSISTANT_ID;

// --- Định nghĩa các hàm để thực thi ---
async function log_progress(args) {
  try {
    await doc.loadInfo();
    const sheet = doc.sheetsByIndex[0]; // Giả sử ghi vào sheet đầu tiên
    
    await sheet.loadHeaderRow();
    const headers = sheet.headerValues;
    
    const rowData = {};
    for (const header of headers) {
        rowData[header] = args[header] !== undefined ? args[header] : ""; // Nếu tham số tồn tại thì dùng, không thì để trống
    }

    await sheet.addRow(rowData);
    return JSON.stringify({ status: 'success', message: 'Data logged successfully' });
  } catch (error) {
    console.error('Google Sheets Error:', error);
    return JSON.stringify({ status: 'error', message: 'Failed to log data' });
  }
}

async function advance_phase(args) {
  // Hàm này chỉ cần trả về pha mới để backend xử lý và gửi cho frontend
  return JSON.stringify({ newPhase: args.next_phase });
}

const availableTools = {
  log_progress,
  advance_phase,
};
// --- Kết thúc định nghĩa hàm ---

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

      await openai.beta.threads.messages.create(threadId, { role: 'user', content: userMessage });
      const run = await openai.beta.threads.runs.create(threadId, { assistant_id: assistantId });

      let runStatus = await openai.beta.threads.runs.retrieve(threadId, run.id);

      // Vòng lặp chờ xử lý, đặc biệt là các yêu cầu hàm (requires_action)
      while (['in_progress', 'queued', 'requires_action'].includes(runStatus.status)) {
        if (runStatus.status === 'requires_action' && runStatus.required_action) {
          const toolCalls = runStatus.required_action.submit_tool_outputs.tool_calls;
          const toolOutputs = [];

          for (const toolCall of toolCalls) {
            const functionName = toolCall.function.name;
            const functionArgs = JSON.parse(toolCall.function.arguments);
            
            if (availableTools[functionName]) {
              const output = await availableTools[functionName](functionArgs);
              toolOutputs.push({ tool_call_id: toolCall.id, output: output });
            }
          }
          await openai.beta.threads.runs.submitToolOutputs(threadId, run.id, { tool_outputs: toolOutputs });
        }
        await new Promise(resolve => setTimeout(resolve, 500)); // Chờ một chút trước khi kiểm tra lại
        runStatus = await openai.beta.threads.runs.retrieve(threadId, run.id);
      }

      if (runStatus.status !== 'completed') {
        throw new Error(`Run failed with status: ${runStatus.status}`);
      }
      
      // Lấy câu trả lời và kiểm tra xem có yêu cầu chuyển pha không
      const messages = await openai.beta.threads.messages.list(threadId, { order: 'asc' });
      const assistantMessage = messages.data.filter(m => m.run_id === run.id && m.role === 'assistant').pop();
      const responseText = assistantMessage.content[0].type === 'text' ? assistantMessage.content[0].text.value : "";
      
      const lastRunSteps = await openai.beta.threads.runs.steps.list(threadId, run.id);
      const toolCallStep = lastRunSteps.data.find(step => step.step_details.type === 'tool_calls');
      let newPhase = null;
      if (toolCallStep) {
          const advancePhaseCall = toolCallStep.step_details.tool_calls.find(tc => tc.function && tc.function.name === 'advance_phase');
          if (advancePhaseCall && advancePhaseCall.output) {
              const output = JSON.parse(advancePhaseCall.output);
              newPhase = output.newPhase;
          }
      }

      return res.status(200).json({ reply: responseText, newPhase: newPhase });
    }
    return res.status(400).json({ error: 'Invalid action' });
  } catch (error) {
    console.error("Server Error:", error);
    return res.status(500).json({ error: error.message });
  }
}

