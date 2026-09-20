const normalize = value => String(value ?? '').replace(/\s+/g, ' ').trim();

export function validateIdentitySpec(spec) {
  if (!spec || typeof spec.selector !== 'string' || !spec.selector.trim() || /REPLACE_|^(body|html|\*)$/i.test(spec.selector)) throw new Error('PROFILE_INCOMPLETE: identity');
  if (spec.pattern) new RegExp(spec.pattern, 'u');
  if (spec.url) {
    const url = new URL(spec.url);
    if (url.origin !== 'https://creator.douyin.com' || url.username || url.password) throw new Error('Invalid identity URL');
  }
}

export async function verifyAccountIdentity(editor, spec, expectedIdentity, {timeoutMs = 15000} = {}) {
  validateIdentitySpec(spec);
  let temporary;
  try {
    const page = spec.url ? (temporary = await editor.context().newPage()) : editor;
    if (temporary) {
      await page.goto(spec.url, {waitUntil:'domcontentloaded', timeout:timeoutMs});
      if (new URL(page.url()).origin !== 'https://creator.douyin.com') throw new Error('Identity page left creator origin');
    }
    const loc = page.locator(spec.selector);
    await loc.waitFor({state:'visible', timeout:timeoutMs});
    if (await loc.count() !== 1) throw new Error('账号标识控件不唯一');
    const raw = normalize(spec.attribute ? await loc.getAttribute(spec.attribute) : await loc.innerText());
    const value = spec.pattern ? normalize(raw.match(new RegExp(spec.pattern,'u'))?.[1]) : raw;
    if (!value || value !== normalize(expectedIdentity)) throw new Error('账号 identity 不匹配，停止上传');
    return value;
  } finally { if (temporary) await temporary.close(); }
}
