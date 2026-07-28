import { MakerSquirrel } from "@electron-forge/maker-squirrel";
import { MakerZIP } from "@electron-forge/maker-zip";
import type { ForgeConfig } from "@electron-forge/shared-types";

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    icon: undefined,
    ignore: [
      /^\/\.next(?!-electron)/u,
      /^\/node_modules/u,
      /^\/release($|\/)/u,
      /^\/out-server($|\/)/u,
      /^\/scripts($|\/)/u,
      /^\/\.git($|\/)/u,
    ],
    extraResource: ["./out-server/standalone"],
  },
  rebuildConfig: {},
  makers: [
    new MakerSquirrel({ name: "multi_agent_desktop" }),
    new MakerZIP({}, ["darwin"]),
  ],
};

export default config;
