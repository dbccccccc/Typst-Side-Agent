export function streamFromStrings(chunks, { holdOpen = false } = {}) {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(encoder.encode(chunks[index++]));
        return;
      }
      if (!holdOpen) controller.close();
    }
  });
}

export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

export class FakeStorage {
  constructor(initial = {}, hooks = {}) {
    this.data = structuredClone(initial);
    this.hooks = hooks;
    this.accessLevel = null;
  }

  async get(keys = null) {
    await this.hooks.beforeGet?.(keys, this);
    if (keys == null) return structuredClone(this.data);
    const names = Array.isArray(keys) ? keys : [keys];
    return Object.fromEntries(names.filter(key => Object.hasOwn(this.data, key)).map(key => [key, structuredClone(this.data[key])]));
  }

  async set(values) {
    await this.hooks.beforeSet?.(values, this);
    for (const [key, value] of Object.entries(values)) this.data[key] = structuredClone(value);
    await this.hooks.afterSet?.(values, this);
  }

  async getKeys() {
    return Object.keys(this.data);
  }

  async remove(keys) {
    for (const key of Array.isArray(keys) ? keys : [keys]) delete this.data[key];
  }

  async getBytesInUse() {
    return new TextEncoder().encode(JSON.stringify(this.data)).length;
  }

  async setAccessLevel({ accessLevel }) {
    this.accessLevel = accessLevel;
  }
}

export function jsonResponse(data, init = {}) {
  return new Response(JSON.stringify(data), {
    status: init.status || 200,
    headers: { 'Content-Type': 'application/json', ...(init.headers || {}) }
  });
}

export function sseResponse(chunks, init = {}) {
  return new Response(streamFromStrings(chunks), {
    status: init.status || 200,
    headers: { 'Content-Type': 'text/event-stream', ...(init.headers || {}) }
  });
}
