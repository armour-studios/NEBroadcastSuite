function createStartGgSyncService({ client, logger }) {
  async function syncSetById(setId) {
    if (!setId) {
      throw new Error('setId is required');
    }

    logger.info({ setId }, 'Start.gg sync requested');

    // Placeholder for upcoming implementation.
    // Planned: fetch set, entrants, teams, and map into app state.
    return {
      ok: true,
      setId,
      syncedAt: new Date().toISOString()
    };
  }

  return {
    syncSetById
  };
}

module.exports = {
  createStartGgSyncService
};
