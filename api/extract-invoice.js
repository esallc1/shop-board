// Server-side only — never expose ANTHROPIC_API_KEY to browser JS.
// Takes a (short-lived, already-authorized) signed URL for an invoice
// image already in Supabase Storage, fetches the bytes here, and asks
// Claude Haiku 4.5 vision to extract vendor/date/amount/PO#/
// description/part_number as strict JSON. Best-effort only:
// bookkeeping-board.html must treat every field as a pre-fill
// suggestion, never a source of truth — Daiana reviews and can
// overwrite anything before confirming.

const SUPPORTED_MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { imageUrl } = req.body || {};
  if (!imageUrl) {
    return res.status(400).json({ error: 'Missing imageUrl' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'API key not configured' });
  }

  try {
    const imgResponse = await fetch(imageUrl);
    if (!imgResponse.ok) {
      return res.status(502).json({ error: `Could not fetch image: ${imgResponse.status}` });
    }

    let mediaType = (imgResponse.headers.get('content-type') || '').split(';')[0].trim();
    if (!SUPPORTED_MEDIA_TYPES.includes(mediaType)) {
      // Fall back to a guess from the URL's extension before giving up —
      // Supabase Storage usually preserves the real mimetype, but be safe.
      const ext = (imageUrl.split('?')[0].split('.').pop() || '').toLowerCase();
      const byExt = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' };
      mediaType = byExt[ext] || null;
    }
    if (!mediaType || !SUPPORTED_MEDIA_TYPES.includes(mediaType)) {
      return res.status(200).json({ vendor: null, date: null, amount: null, po_number: null, description: null, part_number: null, note: 'Unsupported image format' });
    }

    const arrayBuffer = await imgResponse.arrayBuffer();
    const base64 = Buffer.from(arrayBuffer).toString('base64');

    const systemPrompt = `You are an expert at reading vendor invoices, receipts, and parts orders from photos taken on a shop floor — often at an angle, partially obscured, or on crumpled paper.

Extract exactly these six fields from the image and respond with ONLY valid JSON, no markdown code fences, no prose, no explanation:

{"vendor": string or null, "date": string ("YYYY-MM-DD") or null, "amount": number or null, "po_number": string or null, "description": string or null, "part_number": string or null}

Rules:
- vendor: the business/company name that issued the invoice (who was paid), not the shop receiving it.
- date: the invoice or transaction date, formatted YYYY-MM-DD. If the year is missing, use null rather than guessing.
- amount: the total/grand total amount as a plain number (no currency symbol, no commas). If multiple totals appear, use the final total due.
- po_number: a purchase order or reference number if one is visible on the document. Null if none is visible.
- description: the line-item description of what was purchased, exactly as printed on the invoice (e.g. "SPC DW EXTR"). If there are multiple line items, use the primary/first one. Null if not legible.
- part_number: the item/part number printed on the invoice, if any — this is often a separate value from the PO#. Null if none is visible.
- Use null for any field you cannot read with reasonable confidence. Do not guess or estimate.
- Respond with the JSON object and nothing else.`;

    const anthropicResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        temperature: 0,
        system: systemPrompt,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
            { type: 'text', text: 'Extract vendor, date, amount, po_number, description, and part_number from this invoice image. Respond with only the JSON object.' },
          ],
        }],
      }),
    });

    if (!anthropicResponse.ok) {
      const errText = await anthropicResponse.text();
      console.error('[extract-invoice] Anthropic API error', errText);
      return res.status(502).json({ error: 'Anthropic API error' });
    }

    const data = await anthropicResponse.json();
    const rawText = data.content?.[0]?.text || '';

    // Claude was told not to wrap in code fences, but strip them
    // defensively in case it does anyway.
    const jsonText = rawText.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');

    let parsed;
    try {
      parsed = JSON.parse(jsonText);
    } catch (parseErr) {
      console.error('[extract-invoice] Could not parse model output as JSON:', rawText);
      return res.status(200).json({ vendor: null, date: null, amount: null, po_number: null, description: null, part_number: null, note: 'Could not parse extraction result' });
    }

    const amount = typeof parsed.amount === 'number' && isFinite(parsed.amount) ? parsed.amount : null;
    const dateOk = typeof parsed.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(parsed.date) ? parsed.date : null;
    const asString = v => typeof v === 'string' && v.trim() ? v.trim() : null;

    return res.status(200).json({
      vendor: asString(parsed.vendor),
      date: dateOk,
      amount,
      po_number: asString(parsed.po_number),
      description: asString(parsed.description),
      part_number: asString(parsed.part_number),
    });
  } catch (e) {
    console.error('[extract-invoice] failed', e);
    return res.status(500).json({ error: e.message });
  }
}
