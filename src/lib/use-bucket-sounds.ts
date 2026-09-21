import useSound from "use-sound";
import { SOUND_NEED, SOUND_WANT, SOUND_LETGO } from "./sounds";

export function useBucketSounds(muted: boolean) {
  const [playNeed] = useSound(SOUND_NEED, { volume: 0.5, soundEnabled: !muted });
  const [playWant] = useSound(SOUND_WANT, { volume: 0.45, soundEnabled: !muted });
  const [playLetGo] = useSound(SOUND_LETGO, { volume: 0.55, soundEnabled: !muted });
  return { playNeed, playWant, playLetGo };
}
