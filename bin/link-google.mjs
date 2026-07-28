#!/usr/bin/env node
/**
 * Link a Google account once. Everything after this is the server refreshing
 * the token it saved.
 */
import fs from 'node:fs';
import { paths, config } from '../src/config.mjs';
import { authorize, isLinked, linkedAccount, readClient, openBrowser } from '../src/google-auth.mjs';

const args = new Set(process.argv.slice(2));

fs.mkdirSync(config.dataDir, { recursive: true });

if (args.has('--unlink')) {
  fs.rmSync(paths.googleToken, { force: true });
  fs.rmSync(paths.calendarSeen, { force: true });
  fs.rmSync(paths.todoSeen, { force: true });
  fs.rmSync(paths.mailSeen, { force: true });
  console.log('unlinked. Also revoke pitwall at https://myaccount.google.com/permissions');
  process.exit(0);
}

if (args.has('--status')) {
  console.log(`client: ${readClient() ? 'configured' : 'missing'}`);
  console.log(`linked: ${isLinked() ? (linkedAccount() || 'yes') : 'no'}`);
  process.exit(isLinked() ? 0 : 1);
}

if (isLinked() && !args.has('--force')) {
  console.log(`already linked as ${linkedAccount() || 'a Google account'} — re-run with --force to replace it`);
  process.exit(0);
}

try {
  const { account } = await authorize({
    onUrl: (url) => {
      console.log('\nOpen this and approve:\n');
      console.log(`  ${url}\n`);
      if (!args.has('--no-browser')) openBrowser(url);
    },
  });
  console.log(`linked${account ? ` as ${account}` : ''} → ${paths.googleToken}`);
  console.log('restart the server, or wait for its next poll.');
} catch (error) {
  console.error(`\n${error.message}`);
  process.exit(1);
}
