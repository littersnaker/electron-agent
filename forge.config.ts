import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    icon: undefined, // ✨ 显式设为 undefined，彻底关闭图标逻辑，防止底层工具盲目寻找
    
    ignore: [
      /^\/\.next(?!_electron)/, 
      /^\/node_modules/,        
      /^\/out($|\/)/,           
      /^\/out-server($|\/)/,    
      /^\/src($|\/)/,           
      /^\/scripts($|\/)/,       
      /^\/\.git($|\/)/,         
    ],
    extraResource: [
      './out-server/standalone'
    ]
  },
  rebuildConfig: {},
  makers: [
    new MakerSquirrel({
      name: 'my_app', // ✨ 这里的名字也保持全小写、无空格
    }),
    new MakerZIP({}, ['darwin']),
  ],
};

export default config;