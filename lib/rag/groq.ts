import Groq from 'groq-sdk';

let client: Groq | null = null;

export function getGroqClient(): Groq {
  if (!client) {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) throw new Error('GROQ_API_KEY environment variable is not set.');
    client = new Groq({ apiKey });
  }
  return client;
}

// llama-3.3-70b-versatile was moved to Groq's Enterprise-only tier
// (contact-sales pricing) as of their current model lineup, so it 404s on
// normal developer API keys. openai/gpt-oss-120b is Groq's current
// developer-tier flagship model — fast, real rate limits on a free key.
export const GROQ_MODEL = 'openai/gpt-oss-120b';
