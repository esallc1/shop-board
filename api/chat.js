export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { question, boardData } = req.body || {};
  if (!question) {
    return res.status(400).json({ error: 'Missing question' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'API key not configured' });
  }

  const systemPrompt = `You are a shop assistant for Lee Transmission, an auto transmission repair shop. You have access to live board data showing the current state of the shop floor. Answer questions about vehicles, work status, and shop operations concisely and helpfully. Board data is provided as JSON with lifts (6 car lifts), parking (vehicles waiting in the lot), and pickup (vehicles ready for customer pickup).`;

  const userMessage = `Live board data:\n${JSON.stringify(boardData, null, 2)}\n\nQuestion: ${question}`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 1024,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      return res.status(500).json({ error: `Anthropic API error: ${err}` });
    }

    const data = await response.json();
    const answer = data.content?.[0]?.text || 'No response';
    return res.status(200).json({ answer });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
