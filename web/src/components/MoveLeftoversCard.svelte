<script lang="ts">
  import { leftoverAdvice, type MoveLeftover, type RemoveLeftover } from '../lib/move-leftovers';

  // What cameras that moved away (plan D) or were removed (spec
  // 2026-10-30-camera-onboarding-design §4.3) left here that this proxy can't remove.
  let { leftovers = [], removed = [] }: { leftovers?: MoveLeftover[]; removed?: RemoveLeftover[] } = $props();
</script>

<div class="card" data-testid="card-move-leftovers">
  {#if leftovers.length}
    <h3>Left over from camera moves</h3>
    {#each leftovers as l (l.camera)}
      <div class="entry" data-testid="move-leftover-{l.camera}">
        <p><strong>{l.camera}</strong> <span class="muted small">(move {l.moveId})</span></p>
        <ul>
          {#each l.items as item (item)}<li>{leftoverAdvice(l.camera, item)}</li>{/each}
        </ul>
      </div>
    {/each}
  {/if}
  {#if removed.length}
    <h3>Left over from removed cameras</h3>
    {#each removed as l (l.camera)}
      <div class="entry" data-testid="remove-leftover-{l.camera}">
        <p><strong>{l.camera}</strong> <span class="muted small">(removed {new Date(l.at).toLocaleString()})</span></p>
        <ul>
          {#each l.items as item (item)}<li>{leftoverAdvice(l.camera, item)}</li>{/each}
        </ul>
      </div>
    {/each}
  {/if}
</div>

<style>
  .entry + .entry { margin-top: 0.5rem; }
  h3 + .entry, .entry + h3 { margin-top: 0.5rem; }
  ul { margin: 0.25rem 0 0; padding-left: 1.2rem; }
</style>
