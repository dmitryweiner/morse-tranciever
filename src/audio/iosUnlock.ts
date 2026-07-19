// iOS Safari: аппаратный переключатель «без звука» (Ring/Silent) глушит Web
// Audio, т.к. по умолчанию сессия висит на «звонковом» канале. Проигрывание
// короткого беззвучного <audio> внутри пользовательского жеста переводит
// аудиосессию на медиа-канал — и Web Audio перестаёт зависеть от переключателя.
// Скопировано из ../formula-synth (src/audio/iosUnlock.ts).
import { encodeWAV } from './wav';

// Тихий WAV на ~0.5 c: не мгновенный, чтобы iOS успел переключить категорию
// сессии. Кодируем в data-URI (btoa по байтам), чтобы не тащить бинарный ассет.
export function silentWavDataUri(seconds = 0.5, sampleRate = 8000): string {
  const samples = new Float32Array(Math.max(1, Math.round(seconds * sampleRate)));
  const bytes = new Uint8Array(encodeWAV(samples, sampleRate));
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return `data:audio/wav;base64,${btoa(binary)}`;
}

// Держит беззвучный <audio> в цикле, пока движок играет: так iOS не откатывает
// категорию сессии обратно на звонковый канал.
export class IosAudioUnlock {
  private el: HTMLAudioElement | null = null;

  // ВАЖНО: вызывать СИНХРОННО внутри пользовательского жеста, до любого
  // await — иначе iOS не считает это активацией и приём не сработает.
  play(): void {
    if (!this.el) {
      const a = new Audio(silentWavDataUri());
      a.loop = true;
      a.setAttribute('playsinline', '');
      // Элемент НЕ muted намеренно: muted-элемент не меняет категорию сессии
      // (сэмплы всё равно тишина, так что слышно ничего не будет).
      a.volume = 1;
      this.el = a;
    }
    // play() может отклониться (нет жеста, политика автоплея) — молча глотаем.
    void this.el.play().catch(() => {});
  }

  stop(): void {
    if (this.el) {
      this.el.pause();
      this.el.currentTime = 0;
    }
  }
}
