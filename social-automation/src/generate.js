import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export async function generateCarouselContent() {
  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });

  const prompt = `You are a social media content creator specializing in AI for business. Today is ${today}.

Create a 6-slide carousel post for an Instagram/Facebook page about AI tools, AI for business, and AI updates.

Return ONLY valid JSON with this exact structure — no extra text:

{
  "topic": "brief topic name",
  "slides": [
    {
      "number": 1,
      "type": "title",
      "headline": "Attention-grabbing title (max 45 chars)",
      "subtext": "What they will learn (max 65 chars)"
    },
    {
      "number": 2,
      "type": "content",
      "headline": "Point 1 title (max 38 chars)",
      "body": "Key insight or tip (max 85 chars)"
    },
    {
      "number": 3,
      "type": "content",
      "headline": "Point 2 title (max 38 chars)",
      "body": "Key insight or tip (max 85 chars)"
    },
    {
      "number": 4,
      "type": "content",
      "headline": "Point 3 title (max 38 chars)",
      "body": "Key insight or tip (max 85 chars)"
    },
    {
      "number": 5,
      "type": "content",
      "headline": "Point 4 title (max 38 chars)",
      "body": "Key insight or tip (max 85 chars)"
    },
    {
      "number": 6,
      "type": "cta",
      "headline": "Follow for daily AI tips",
      "subtext": "Save this post for later"
    }
  ],
  "caption": "Engaging 2-3 sentence caption followed by 15 relevant hashtags about AI and business. Make it feel human and insightful."
}

Topic ideas — pick the most fresh and relevant:
- Top AI tools saving entrepreneurs hours daily
- How to use Claude or ChatGPT to write better emails
- AI automation workflows for small businesses
- Latest AI tools you need to know this week
- Prompts that make AI 10x more useful for business
- How AI is changing content creation
- AI tools for solopreneurs and coaches
- How to build a business with AI in 2025`;

  const response = await client.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 2000,
    messages: [{ role: 'user', content: prompt }]
  });

  const text = response.content[0].text.trim();
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON found in Claude response');

  return JSON.parse(jsonMatch[0]);
}
