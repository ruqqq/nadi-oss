import { Agent, type Connection } from "agents";
import { withVoiceInput, WorkersAINova3STT } from "@cloudflare/voice";
import { registryDb } from "../db/client";
import { VoiceRepository } from "../db/repositories/voice";
import { platformCapabilities } from "../edition";
import type { Env } from "../env";
import { voiceInputEnabled } from "../flags";
import { log } from "../log";
import { resolveVoiceLanguage } from "./voice-language";
import { VOICE_CALL_CEILING_MS } from "./voice-limits";

export { resolveVoiceLanguage, VOICE_CALL_CEILING_MS };

const VoiceInputAgent = withVoiceInput(Agent);

/**
 * Per-user dictation agent. The instance name is always the session user id —
 * the worker rewrites the client-supplied room before routing (see src/index.ts),
 * so `this.name` is trustworthy and is what we key the language lookup on.
 *
 * Holds no persistent state: PCM streams in, transcripts stream out, nothing is
 * written to storage.
 */
export class VoiceAgent extends VoiceInputAgent<Env> {
  // The instance name is the user id; don't echo it back over the socket.
  static options = { sendIdentityOnConnect: false };

  #language = "en";
  // Keyed by connection.id: the DO is per-user and shared across every tab that
  // user has open, so a single field would let one tab's call cancel another's
  // ceiling — or leak a timer when its connection went away.
  #ceilings = new Map<string, ReturnType<typeof setTimeout>>();

  /**
   * Runs before createTranscriber() on every call start (voice.js:506-510), so
   * this is where both the flag gate and the language read belong. Returning
   * false makes the mixin clean up without ever starting a transcriber, so a
   * forged socket bills no audio.
   */
  async beforeCallStart(_connection: Connection): Promise<boolean> {
    if (!voiceInputEnabled(this.env)) {
      log.info("voice.call.rejected", {
        reason: platformCapabilities(this.env).speechToText
          ? "flag_off"
          : "platform_lacks_speech_to_text",
      });
      return false;
    }
    // this.name is the session user id, but partyserver passes the raw path
    // segment to idFromName without decoding, so it's percent-encoded — decode
    // before using it as the D1 lookup key (encoding is identity for Better
    // Auth's alphanumeric ids today, but won't always be).
    const userId = decodeURIComponent(this.name);
    const stored = await new VoiceRepository(registryDb(this.env)).getLanguage(userId);
    this.#language = resolveVoiceLanguage(stored);
    return true;
  }

  createTranscriber(_connection: Connection) {
    return new WorkersAINova3STT(this.env.AI, { language: this.#language });
  }

  onTranscript(_text: string, _connection: Connection) {
    // The mixin already sends `transcript` / `transcript_interim` frames to the
    // client, which is all the composer consumes. Nothing to persist.
  }

  /** Arms the ceiling. Closing the socket is what actually stops the audio: it
   *  runs the mixin's onClose, which tears down the transcriber session. */
  onCallStart(connection: Connection) {
    this.#clearCeiling(connection.id);
    this.#ceilings.set(
      connection.id,
      setTimeout(() => {
        this.#ceilings.delete(connection.id);
        log.warn("voice.call.ceiling", { connectionId: connection.id });
        try {
          connection.close(1000, "voice call exceeded the maximum duration");
        } catch {
          // Already gone; onClose has cleaned up.
        }
      }, VOICE_CALL_CEILING_MS),
    );
  }

  onCallEnd(connection: Connection) {
    this.#clearCeiling(connection.id);
  }

  // A dropped socket never sends end_call, so the ceiling has to be cleared here
  // too or the timer outlives the connection it was guarding.
  onClose(connection: Connection) {
    this.#clearCeiling(connection.id);
  }

  #clearCeiling(connectionId: string) {
    const timer = this.#ceilings.get(connectionId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.#ceilings.delete(connectionId);
    }
  }
}
