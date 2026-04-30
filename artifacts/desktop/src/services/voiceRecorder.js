import { getOpenAIKey } from './keys';

export class VoiceRecorder {
  constructor(onTranscript, onError, onStatusChange) {
    this.onTranscript = onTranscript;
    this.onError = onError;
    this.onStatusChange = onStatusChange || (() => {});
    this.mediaRecorder = null;
    this.chunks = [];
    this.stream = null;
    this.isListening = false;
    this.isTranscribing = false;
  }

  // existingStream: if provided, use it directly and do NOT stop its tracks when done
  async start(existingStream = null) {
    if (this.isListening || this.isTranscribing) return;

    try {
      if (existingStream) {
        this.stream = existingStream;
        this._ownStream = false; // caller owns the stream; we must not stop its tracks
      } else {
        this.stream = await navigator.mediaDevices.getUserMedia({
          audio: { sampleRate: 16000, channelCount: 1, echoCancellation: true, noiseSuppression: true },
        });
        this._ownStream = true;
      }

      this.chunks = [];

      const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg'].find(
        t => MediaRecorder.isTypeSupported(t)
      ) || '';

      this.mediaRecorder = new MediaRecorder(this.stream, mimeType ? { mimeType } : {});

      this.mediaRecorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) this.chunks.push(e.data);
      };

      this.mediaRecorder.onstop = async () => {
        this.isListening = false;
        // Only stop tracks if we own the stream; borrowed streams stay alive for future PTT calls
        if (this._ownStream) {
          this.stream?.getTracks().forEach(t => t.stop());
          this.stream = null;
        }

        if (this.chunks.length === 0) {
          this.onStatusChange('idle');
          return;
        }

        const blob = new Blob(this.chunks, { type: this.mediaRecorder.mimeType || 'audio/webm' });
        this.chunks = [];

        if (blob.size < 4000) {
          this.onStatusChange('idle');
          return;
        }

        this.isTranscribing = true;
        this.onStatusChange('transcribing');
        await this._transcribeWithWhisper(blob);
        this.isTranscribing = false;
        this.onStatusChange('idle');
      };

      this.mediaRecorder.start(100);
      this.isListening = true;
      this.onStatusChange('listening');
    } catch (err) {
      this.isListening = false;
      if (err.name === 'NotAllowedError') {
        this.onError('Microphone access denied. Please grant permission in System Settings → Privacy → Microphone.');
      } else if (err.name === 'NotFoundError') {
        this.onError('No microphone found. Please connect a microphone.');
      } else {
        this.onError(`Microphone error: ${err.message}`);
      }
    }
  }

  stop() {
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      this.mediaRecorder.stop();
    } else if (this.stream && this._ownStream) {
      this.stream.getTracks().forEach(t => t.stop());
      this.stream = null;
      this.isListening = false;
      this.onStatusChange('idle');
    } else {
      this.isListening = false;
      this.onStatusChange('idle');
    }
  }

  async _transcribeWithWhisper(blob) {
    const key = getOpenAIKey();
    if (!key) {
      this.onError('OpenAI API key not configured. Add OPENAI_API_KEY to your environment and restart.');
      return;
    }

    try {
      const ext = blob.type.includes('ogg') ? 'ogg' : 'webm';
      const formData = new FormData();
      formData.append('file', blob, `recording.${ext}`);
      formData.append('model', 'whisper-1');
      formData.append('language', 'en');

      const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}` },
        body: formData,
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        if (res.status === 401) {
          this.onError('OpenAI API key is invalid. Please check your OPENAI_API_KEY.');
        } else {
          this.onError(`Whisper error ${res.status}: ${err.error?.message || 'Unknown error'}`);
        }
        return;
      }

      const data = await res.json();
      const text = data.text?.trim();
      if (text && text.length > 0) {
        this.onTranscript(text);
      }
    } catch (err) {
      this.onError(`Transcription failed: ${err.message}`);
    }
  }
}
