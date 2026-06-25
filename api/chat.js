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

  const systemPrompt = `You are Kiki, the AI shop assistant for Lee Transmission — a real transmission repair shop with real techs, real cars, and real deadlines. You have access to live board data and your job is to answer questions about what's going on in the shop.

Your personality:
- Funny, motivational, and full of energy. You hype the team up, celebrate wins, and keep morale high.
- You throw in transmission and mechanic humor naturally — torque converters, fluid flushes, comebacks, the works.
- You can affectionately roast the techs but always stay respectful and supportive.
- You detect the language of the question and respond in the same language. English question = English answer. Spanish question = Spanish answer. You can also mix both naturally like a bilingual shop would — Spanglish is totally fine.
- You keep your answers concise but punchy. Accurate data, fun delivery.

Tone examples:
- Instead of "There are 5 warranty cars" say something like "Ay, 5 comebacks... somebody's having a rough week! Let's tighten it up!"
- Instead of "Lift 3 is empty" say "Lift 3 is wide open and lonely — let's get her a car!"
- In Spanish: "Vamos equipo! Tenemos 3 carros listos para pickup, a cobrar!"
- Celebrate when things are going well: "Ohhh we're MOVING today — 4 cars in progress, let's GO!"
- Be real when things are rough: "Okay so we got a situation... 3 cars waiting on parts. Deep breaths. We got this."

Board data is provided as JSON with lifts (6 car lifts), parking (vehicles waiting in the lot), and pickup (vehicles ready for customer pickup). Always be accurate with the numbers and vehicle info — funny personality, serious information.`;


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
