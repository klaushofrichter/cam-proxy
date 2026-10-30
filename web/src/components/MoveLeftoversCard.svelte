<script lang="ts">
  import { leftoverAdvice, type MoveLeftover } from '../lib/move-leftovers';

  // What cameras that moved away left here that this proxy can't remove (plan D).
  let { leftovers }: { leftovers: MoveLeftover[] } = $props();
</script>

<div class="card" data-testid="card-move-leftovers">
  <h3>Left over from camera moves</h3>
  {#each leftovers as l (l.camera)}
    <div class="entry" data-testid="move-leftover-{l.camera}">
      <p><strong>{l.camera}</strong> <span class="muted small">(move {l.moveId})</span></p>
      <ul>
        {#each l.items as item (item)}<li>{leftoverAdvice(l.camera, item)}</li>{/each}
      </ul>
    </div>
  {/each}
</div>

<style>
  .entry + .entry { margin-top: 0.5rem; }
  ul { margin: 0.25rem 0 0; padding-left: 1.2rem; }
</style>
