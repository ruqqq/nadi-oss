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
  static options = {
    // The instance name is the user id; don't echo it back over the socket.
    sendIdentityOnConnect: false,
    // Duration is billed while the DO is resident, and partyserver's default
    // (hibernate: false) attaches JS handlers to the socket, which pins the
    // object for as long as a tab holds a connection — minutes of dead air per
    // dictation. Hibernating hands the socket to the runtime instead, so an
    // idle connection costs nothing.
    //
    // This is what @cloudflare/voice already expects: the mixin takes an
    // explicit keepAlive() at start_call and releases it at end_call
    // (voice.js:520, :546). That pin is what keeps the transcriber's outbound
    // WebSocket and audio buffers alive for the duration of a call — none of
    // which could survive eviction. With hibernate:false that keepAlive was
    // redundant and its release bought nothing.
    hibernate: true,
  };

  // Written in beforeCallStart and read by createTranscriber, which the mixin
  // calls in the same #handleStartCall invocation (voice.js:507-510). A DO is
  // never evicted with a task in flight, so this one instance field is safe to
  // hold across that gap even under hibernation.
  #language = "en";

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
   *  runs the mixin's onClose, which tears down the transcriber session.
   *
   *  The schedule row is the record — there is no in-memory mirror of it. That
   *  is deliberate: a Map keyed by connection id would be instance state, and
   *  under hibernation the instance that armed a ceiling need not be the one
   *  that disarms it. */
  async onCallStart(connection: Connection) {
    await this.#clearCeiling(connection.id);
    await this.schedule(VOICE_CALL_CEILING_MS / 1000, "closeCallAtCeiling", {
      connectionId: connection.id,
    });
  }

  async onCallEnd(connection: Connection) {
    await this.#clearCeiling(connection.id);
  }

  /** Fired by the durable schedule armed in onCallStart. Public because
   *  `schedule()` dispatches by method name. */
  async closeCallAtCeiling(payload: { connectionId: string }) {
    log.warn("voice.call.ceiling", { connectionId: payload.connectionId });
    for (const connection of this.getConnections()) {
      if (connection.id !== payload.connectionId) continue;
      try {
        connection.close(1000, "voice call exceeded the maximum duration");
      } catch {
        // Already gone; onClose has cleaned up.
      }
    }
  }

  // A dropped socket never sends end_call, so the ceiling has to be cleared here
  // too or the schedule outlives the connection it was guarding.
  async onClose(connection: Connection) {
    await this.#clearCeiling(connection.id);
  }

  async #clearCeiling(connectionId: string) {
    for (const schedule of await this.listSchedules()) {
      if (schedule.callback !== "closeCallAtCeiling") continue;
      const payload = schedule.payload as { connectionId?: string } | undefined;
      if (payload?.connectionId !== connectionId) continue;
      await this.cancelSchedule(schedule.id);
    }
  }
}
