/**
 * FareWatch — Gmail auto-import (Google Apps Script)
 *
 * Runs inside YOUR Google account, so no Google app review or OAuth setup is needed. Every 15 minutes it
 * finds likely flight/hotel confirmation emails, sends them to your FareWatch app, and labels them
 * "FareWatch" so each is only sent once. Non-booking emails are recognised and ignored by the app.
 *
 * Setup (5 minutes):
 *   1. Go to https://script.google.com → New project, and paste this whole file into Code.gs.
 *   2. Fill in APP_URL and INBOUND_SECRET below (same value as INBOUND_SECRET in your app's settings).
 *   3. Choose the `setup` function in the toolbar and click Run. Approve the permissions
 *      (Gmail read + label, connect to an external service). Google will warn that the app is
 *      unverified because you wrote it yourself — click Advanced → Go to project.
 *   That's it. The first runs import confirmations from the last LOOKBACK_DAYS days, a few at a time.
 */

const APP_URL = 'https://YOUR-APP.vercel.app';
const INBOUND_SECRET = 'PASTE-YOUR-INBOUND_SECRET';

const LABEL = 'FareWatch';
const LOOKBACK_DAYS = 180;
// Each email takes the app ~10–30 s to read with AI; Apps Script runs are capped at 6 minutes.
const MAX_THREADS_PER_RUN = 8;
const QUERY =
  'newer_than:' + LOOKBACK_DAYS + 'd -category:promotions -category:social -label:' + LABEL +
  ' subject:(confirmation OR confirmed OR itinerary OR reservation OR "e-ticket" OR eticket OR "your trip" OR "your stay" OR "your flight")';

function importConfirmations() {
  const label = GmailApp.getUserLabelByName(LABEL) || GmailApp.createLabel(LABEL);
  const threads = GmailApp.search(QUERY, 0, MAX_THREADS_PER_RUN);
  for (const thread of threads) {
    let delivered = true;
    for (const message of thread.getMessages()) {
      const response = UrlFetchApp.fetch(
        APP_URL + '/api/inbound-email?secret=' + encodeURIComponent(INBOUND_SECRET),
        {
          method: 'post',
          contentType: 'application/json',
          muteHttpExceptions: true,
          payload: JSON.stringify({
            Source: 'gmail-script',
            MessageID: message.getId(),
            From: message.getFrom(),
            To: message.getTo(),
            Subject: message.getSubject(),
            HtmlBody: message.getBody(),
            TextBody: message.getPlainBody(),
          }),
        },
      );
      const code = response.getResponseCode();
      if (code === 401) throw new Error('FareWatch rejected the secret — check INBOUND_SECRET.');
      // 5xx = temporary problem on the app side; leave the thread unlabeled so it's retried next run.
      if (code >= 500) delivered = false;
    }
    if (delivered) thread.addLabel(label);
  }
}

/** Run once: installs the 15-minute trigger (replacing any previous one) and does a first import. */
function setup() {
  for (const trigger of ScriptApp.getProjectTriggers()) {
    if (trigger.getHandlerFunction() === 'importConfirmations') ScriptApp.deleteTrigger(trigger);
  }
  ScriptApp.newTrigger('importConfirmations').timeBased().everyMinutes(15).create();
  importConfirmations();
}
