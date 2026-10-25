import type { ProbeResult } from '../engine/probe';

/**
 * chrome.runtime messages reach every extension context, so each one names its target.
 * Progress is not messaged: the engine writes it to IndexedDB and pages observe it via Dexie liveQuery.
 */
export type BackgroundMessage =
  | { target: 'background'; type: 'start'; id: string }
  | { target: 'background'; type: 'cancel'; id: string }
  | { target: 'background'; type: 'probe'; url: string }
  | { target: 'background'; type: 'deliver'; id: string; blobUrl: string; filename: string };

export type OffscreenMessage =
  | { target: 'offscreen'; type: 'start'; id: string }
  | { target: 'offscreen'; type: 'cancel'; id: string }
  | { target: 'offscreen'; type: 'probe'; url: string }
  | { target: 'offscreen'; type: 'cleanup'; id: string };

/** Messages between the offscreen document and its engine worker. */
export type WorkerRequest =
  | { type: 'start'; id: string }
  | { type: 'cancel'; id: string }
  | { type: 'probe'; requestId: number; url: string }
  | { type: 'delete'; id: string };

export type WorkerEvent =
  | { type: 'ready-to-deliver'; id: string; filename: string }
  | { type: 'probe-result'; requestId: number; result?: ProbeResult & { steps: string[] }; error?: string }
  | { type: 'log'; message: string };

export type ProbeResponse = { result?: ProbeResult & { steps: string[] }; error?: string };

type WithoutTarget<T> = T extends unknown ? Omit<T, 'target'> : never;

export function sendToBackground<T = unknown>(msg: WithoutTarget<BackgroundMessage>): Promise<T> {
  return chrome.runtime.sendMessage({ ...msg, target: 'background' });
}
