import type { ReolinkClient } from '../camera/client';

interface AiState { people?: { alarm_state?: number }; vehicle?: { alarm_state?: number }; dog_cat?: { alarm_state?: number } }

// The fallback: the camera's current detection state by HTTP.
export async function pollStates(client: ReolinkClient): Promise<Record<string, boolean>> {
  const md = await client.command<{ state?: number }>('GetMdState', { channel: 0 });
  const ai = await client.command<AiState>('GetAiState', { channel: 0 });
  return {
    motion: md.state === 1,
    person: ai.people?.alarm_state === 1,
    vehicle: ai.vehicle?.alarm_state === 1,
    pet: ai.dog_cat?.alarm_state === 1,
  };
}
