/**
 * Telegram inline keyboard builder utilities.
 */

export interface InlineButton {
  text: string;
  callback_data: string;
}

export function makeButton(text: string, callbackData: string): InlineButton {
  return { text, callback_data: callbackData };
}

export function makeKeyboard(rows: InlineButton[][]): { inline_keyboard: InlineButton[][] } {
  return { inline_keyboard: rows };
}

/**
 * Build provider list keyboard with action buttons per provider.
 */
export function providerListKeyboard(
  providers: { id: string; name: string; isCurrent: boolean; appType: string }[]
): { inline_keyboard: InlineButton[][] } {
  const rows: InlineButton[][] = [];

  for (const p of providers) {
    const prefix = p.isCurrent ? '✅ ' : '';
    const label = `${prefix}${p.name} [${p.appType}]`;
    rows.push([
      makeButton(label, `noop:${p.id}`),
    ]);
    rows.push([
      makeButton('🔄 Switch', `switch:${p.id}`),
      makeButton('🔍 Test', `test:${p.id}`),
      makeButton('🗑 Delete', `del_confirm:${p.id}`),
    ]);
  }

  return makeKeyboard(rows);
}

/**
 * Build app type selection keyboard.
 */
export function appTypeKeyboard(action: string): { inline_keyboard: InlineButton[][] } {
  return makeKeyboard([
    [
      makeButton('Claude', `${action}:claude`),
      makeButton('Codex', `${action}:codex`),
      makeButton('Gemini', `${action}:gemini`),
    ],
  ]);
}

/**
 * Build switch confirmation keyboard.
 */
export function switchConfirmKeyboard(providers: { id: string; name: string; appType: string }[]): { inline_keyboard: InlineButton[][] } {
  const rows: InlineButton[][] = providers.map(p => [
    makeButton(`${p.name} [${p.appType}]`, `switch:${p.id}`),
  ]);
  return makeKeyboard(rows);
}

/**
 * Delete confirmation keyboard.
 */
export function deleteConfirmKeyboard(providerId: string): { inline_keyboard: InlineButton[][] } {
  return makeKeyboard([
    [
      makeButton('✅ Yes, delete', `del_exec:${providerId}`),
      makeButton('❌ Cancel', 'del_cancel'),
    ],
  ]);
}

/**
 * Config app type keyboard.
 */
export function configAppKeyboard(): { inline_keyboard: InlineButton[][] } {
  return appTypeKeyboard('config');
}

/**
 * Stats period keyboard.
 */
export function statsPeriodKeyboard(): { inline_keyboard: InlineButton[][] } {
  return makeKeyboard([
    [
      makeButton('7 days', 'stats:7'),
      makeButton('30 days', 'stats:30'),
      makeButton('90 days', 'stats:90'),
    ],
  ]);
}
