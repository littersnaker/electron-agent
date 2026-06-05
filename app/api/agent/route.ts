import { GoogleGenAI } from "@google/genai";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
});

export async function POST(req: Request) {
  if (!process.env.GEMINI_API_KEY) {
    return NextResponse.json(
      { error: "Missing GEMINI_API_KEY in .env.local" },
      { status: 500 },
    );
  }

  const { message } = (await req.json()) as { message?: string };

  if (!message?.trim()) {
    return NextResponse.json(
      { error: "Message is required." },
      { status: 400 },
    );
  }

  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: message,
    config: {
      systemInstruction: "You are a helpful AI agent.",
    },
  });

  return NextResponse.json({
    output: response.text,
  });
}
