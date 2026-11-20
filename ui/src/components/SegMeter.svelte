<script>
  import { meterSegments } from '../lib/format.js'

  let { used = null, count = 10, size = 'md', segments = null, label = '' } = $props()

  let computed = $derived(meterSegments(used, count))
</script>

<span class="seg-meter {size}" role="img" aria-label={label || (computed.percent !== null ? `${computed.percent}%` : '')}>
  {#if Array.isArray(segments)}
    {#each segments as tone, idx (idx)}
      <span class="seg-cell" class:on={Boolean(tone)} class:ok={tone === 'ok'} class:warn={tone === 'warn'} class:err={tone === 'err'} class:working={tone === 'working'} class:done={tone === 'done'} class:muted={tone === 'muted'}></span>
    {/each}
  {:else}
    {#each computed.cells as on, idx (idx)}
      <span class="seg-cell" class:on class:ok={on && computed.tone === 'ok'} class:warn={on && computed.tone === 'warn'} class:err={on && computed.tone === 'err'} class:muted={on && computed.tone === 'muted'}></span>
    {/each}
  {/if}
</span>
