const { createClipManager } = require('./clip-manager');
const { createMontageEncoder } = require('./montage-encoder');

function createClipSystem({ dataDir, getObsClient, onUpdate, onEncodeProgress, onCapture }) {
  const manager = createClipManager({
    dataDir,
    getObsClient,
    onUpdate,
    onCapture
  });

  const encoder = createMontageEncoder({
    clipsDir: manager.getClipsDir(),
    onProgress: (progress) => {
      const active = progress.active;
      if (active?.montageId) {
        if (active.status === 'encoding') manager.updateMontageStatus(active.montageId, 'encoding');
        if (active.status === 'done' && active.outputPath) {
          manager.updateMontageStatus(active.montageId, 'exported', active.outputPath);
        }
        if (active.status === 'error') manager.updateMontageStatus(active.montageId, 'error');
      }
      if (onEncodeProgress) onEncodeProgress(progress);
    }
  });

  function enqueueMontage(montageId, name, opts) {
    const { segments, template } = manager.getClipSegmentsForMontage(montageId);
    if (!segments.length) {
      return { error: 'No clips with a video file in this montage. Captured clips need an OBS replay file (not just a placeholder).' };
    }
    const jobId = encoder.enqueue({ name, segments, montageId, template, opts });
    manager.updateMontageStatus(montageId, 'encoding');
    return { jobId };
  }

  async function onHighlightEvent(meta) {
    return manager.captureHighlight(meta);
  }

  return {
    manager,
    encoder,
    onHighlightEvent,
    enqueueMontage,
    setSettings: (p) => manager.setSettings(p),
    getLastError: () => manager.getLastError(),
    getState: () => ({
      ...manager.getState(),
      templates: require('./templates').listTemplates(),
      encode: encoder.getQueue()
    })
  };
}

module.exports = { createClipSystem };