// app/api/config/route.ts
import { NextResponse } from 'next/server';

export async function GET() {
  // 检查环境变量是否存在
  const hasDefaultKey = !!process.env.DASHSCOPE_API_KEY;
  
  return NextResponse.json({
    hasDefaultKey,
  });
}