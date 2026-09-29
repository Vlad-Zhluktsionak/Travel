import { ingestEmail } from "../ingest";
import * as repo from "../repo";
import { mailboxProviders } from "./mailbox";

/** Scan a connected mailbox for new flight confirmations. The first sync looks back 180 days. */
export async function syncConnection(connection: repo.MailConnection) {
  const provider = mailboxProviders[connection.provider];
  const sinceDays = connection.lastSyncedAt ? 14 : 180;
  const { refreshToken, messages } = await provider.fetchCandidates(connection.refreshToken, sinceDays);

  const summary = { scanned: messages.length, added: 0, updated: 0, skipped: 0, failed: 0 };
  for (const message of messages) {
    if (!repo.markMessageProcessed(connection.userId, connection.provider, message.id)) continue;
    try {
      const result = await ingestEmail(connection.userId, message, connection.provider);
      if (!result.ok) summary.skipped++;
      else if (result.created) summary.added++;
      else summary.updated++;
    } catch (err) {
      summary.failed++;
      repo.unmarkMessageProcessed(connection.userId, connection.provider, message.id);
      console.error(`Failed to ingest ${connection.provider} message ${message.id}`, err);
    }
  }
  repo.updateConnectionAfterSync(connection.id, refreshToken);
  return summary;
}

export async function syncAllConnections() {
  const results = [];
  for (const connection of repo.listConnections()) {
    try {
      results.push({ id: connection.id, ...(await syncConnection(connection)) });
    } catch (err) {
      results.push({ id: connection.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return results;
}
