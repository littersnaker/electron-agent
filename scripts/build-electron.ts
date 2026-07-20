/// <reference types="node" />
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const rootDir = process.cwd();

try {
  console.log('=== Step 1: 编译 Electron 主进程 TypeScript ===');
  execSync('pnpm electron:compile', { stdio: 'inherit', cwd: rootDir });

  console.log('\n=== Step 2: 构建 Next.js 前端项目 (Standalone Mode) ===');
  execSync('pnpm run build', { stdio: 'inherit', cwd: rootDir });

  console.log('\n=== Step 3: 自动整理 Next.js 生产环境服务文件 ===');
  const outServerDir = path.join(rootDir, 'out-server/standalone');
  
  fs.rmSync(path.join(rootDir, 'out-server'), { recursive: true, force: true });
  fs.mkdirSync(outServerDir, { recursive: true });

  const standaloneSource = path.join(rootDir, '.next/standalone');
  if (!fs.existsSync(standaloneSource)) {
    throw new Error('.next/standalone 目录不存在，请检查 Next.js 是否成功构建。');
  }
  fs.cpSync(standaloneSource, outServerDir, { recursive: true, dereference: true });

  const destStatic = path.join(outServerDir, '.next/static');
  fs.mkdirSync(destStatic, { recursive: true });
  fs.cpSync(path.join(rootDir, '.next/static'), destStatic, { recursive: true });

  const sourcePublic = path.join(rootDir, 'public');
  if (fs.existsSync(sourcePublic)) {
    const destPublic = path.join(outServerDir, 'public');
    fs.mkdirSync(destPublic, { recursive: true });
    fs.cpSync(sourcePublic, destPublic, { recursive: true });
  }

  // const symlinkPaths = [
  //   // path.join(outServerDir, 'node_modules'),
  //   // path.join(outServerDir, '.next', 'node_modules'),
  // ];
  // for (const p of symlinkPaths) {
  //   if (fs.existsSync(p)) {
  //     fs.rmSync(p, { recursive: true, force: true });
  //   }
  // }

  console.log('\n=== Step 4: electron-builder 打包绿色运行版 ===');
  execSync('pnpm exec electron-builder --dir', { stdio: 'inherit', cwd: rootDir });
  
  console.log('\n🎉 [成功] 绿色运行版已生成！请前往 out/MyApp-win32-x64 目录查看。');
  console.log('💡 如需生成安装包，请运行: pnpm electron:make');

} catch (error) {
  console.error('\n❌ 构建或打包过程中发生错误:', error);
  process.exit(1);
}