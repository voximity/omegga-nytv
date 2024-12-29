import OmeggaPlugin, {
  OL,
  PS,
  PC,
  Vector,
  ReadSaveObject,
  IBrickBounds,
} from 'omegga';
import * as fs from 'node:fs/promises';
import path from 'node:path';

type Config = {
  scene_directory: string;
  autoplay_scenes: string[];
  autoplay_interval_secs: number;
};
type Storage = {};

type Region = { center: Vector; extent: Vector };

function boundsToRegion({ center, maxBound }: IBrickBounds): Region {
  const extent = maxBound.map((c, i) => c - center[i]) as Vector;
  return { center, extent };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve, _) => setTimeout(resolve, ms));
}

export default class Plugin implements OmeggaPlugin<Config, Storage> {
  omegga: OL;
  config: PC<Config>;
  store: PS<Storage>;

  scenes: Record<string, ReadSaveObject> = {};
  lastRegion?: Region;

  autoplayInterval: NodeJS.Timeout = null;
  autoplayIndex: number = 0;
  autoplayLastTime: number;
  sceneLoading = false;
  playingTempScene = false;

  constructor(omegga: OL, config: PC<Config>, store: PS<Storage>) {
    this.omegga = omegga;
    this.config = config;
    this.store = store;
  }

  unloadScene = () => {
    if (!this.lastRegion) return;
    this.omegga.clearRegion(this.lastRegion);
    this.lastRegion = null;
  };

  loadScene = (name: string) => {
    if (this.sceneLoading) return;

    const scene = this.scenes[name];
    if (!scene) {
      console.error(
        `scene "${name}" is not loaded! ignoring request to load...`
      );
      return;
    }

    this.sceneLoading = true;
    this.unloadScene();
    this.omegga
      .loadSaveData(scene, {
        quiet: true,
        correctPalette: false,
        correctCustom: false,
      })
      .then(() => {
        this.lastRegion = boundsToRegion(OMEGGA_UTIL.brick.getBounds(scene));
      })
      .catch((e) => {
        console.error(`failed to load scene "${name}"! reason: ${e}`);
      })
      .finally(() => {
        this.sceneLoading = false;
      });
  };

  autoplayNext = () => {
    this.autoplayLastTime = Date.now();
    const scene = this.config.autoplay_scenes[this.autoplayIndex];

    this.loadScene(scene);

    this.autoplayIndex =
      (this.autoplayIndex + 1) % this.config.autoplay_scenes.length;
  };

  resumeAutoplay = async (after?: number) => {
    if (!this.config.autoplay_scenes.length) return;

    if (after && after > 0) {
      await sleep(after);
    }

    this.autoplayNext();
    this.autoplayInterval = setInterval(
      this.autoplayNext,
      this.config.autoplay_interval_secs * 1000
    );
  };

  playTempScene = async (name: string, duration_secs: number) => {
    if (this.playingTempScene) return;
    this.playingTempScene = true;

    if (this.autoplayInterval) {
      clearInterval(this.autoplayInterval);
    }

    this.loadScene(name);
    await sleep(duration_secs * 1000);

    this.resumeAutoplay(
      this.config.autoplay_interval_secs -
        (Date.now() - this.autoplayLastTime) / 1000
    );
    this.playingTempScene = false;
  };

  async init() {
    // load scenes from scene_directory
    try {
      const files = await fs.readdir(this.config.scene_directory);
      const scenes = await Promise.all(
        files
          .filter((file) => file.endsWith('.brs'))
          .map(async (file) => {
            const filePath = path.join(this.config.scene_directory, file);
            const content = new Uint8Array(await fs.readFile(filePath));
            return [
              file.substring(0, file.length - 4),
              OMEGGA_UTIL.brs.read(content),
            ];
          })
      );

      this.scenes = Object.fromEntries(scenes);
    } catch (err) {
      console.error('failed to load scenes! reason is below.');
      console.error(err);
      return;
    }

    console.log(`loaded ${this.scenes.length} scenes`);

    // determine which scenes to autoplay from config
    const autoplay = [];
    for (const sceneName of this.config.autoplay_scenes) {
      if (sceneName in this.scenes) {
        autoplay.push(sceneName);
        continue;
      }

      console.warn(`autoplay scene ${sceneName} could not be found!`);
    }

    this.config.autoplay_scenes = autoplay;
    // autoplay cycle with configured interval
    if (!this.config.autoplay_scenes.length) {
      console.warn(
        `no autoplay scenes configured! autoplay loop will not be started.`
      );
    } else {
      this.resumeAutoplay();
    }

    // allow interact components with `scene:my-scene` to override the current scene
    //   for a configured interval and pause the autoplay cycle
  }

  async stop() {
    this.unloadScene();
  }
}
