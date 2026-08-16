/** Transactional controller for custom/MCP record arrays. */
export function createRecordRegistryController({ getRecords, setRecords, persist }) {
  if (![getRecords, setRecords, persist].every(value => typeof value === 'function')) throw new TypeError('Registry controller dependencies are required.');
  let queue = Promise.resolve();

  function mutate(transform, mutation) {
    const operation = queue.then(async () => {
      const next = [...transform(getRecords())];
      const saved = await persist(next, mutation);
      const committed = Array.isArray(saved?.records) ? saved.records : next;
      setRecords(committed);
      return committed;
    });
    queue = operation.catch(() => {});
    return operation;
  }

  function replace(records) {
    const replacement = [...records];
    return mutate(() => replacement, { type: 'replace', records: replacement });
  }

  return Object.freeze({
    replace,
    upsert(record) {
      return mutate(records => {
        const position = records.findIndex(item => item.id === record.id);
        if (position < 0) return [...records, { ...record }];
        const next = records.slice();
        next[position] = { ...next[position], ...record };
        return next;
      }, { type: 'upsert', record: { ...record } });
    },
    remove(id) {
      return mutate(records => records.filter(record => record.id !== id), { type: 'remove', id });
    },
    toggle(id) {
      return mutate(records => records.map(record => record.id === id ? { ...record, enabled: record.enabled === false } : record), { type: 'toggle', id });
    }
  });
}

/** Transactional controller for models and their active/auto-name references. */
export function createModelRegistryController({ getSettings, setSettings, persist }) {
  if (![getSettings, setSettings, persist].every(value => typeof value === 'function')) throw new TypeError('Model registry controller dependencies are required.');
  let queue = Promise.resolve();

  function mutate(transform, mutation) {
    const operation = queue.then(async () => {
      const next = transform(getSettings());
      const saved = await persist(next, mutation);
      const committed = saved?.settings && typeof saved.settings === 'object' ? saved.settings : next;
      setSettings(committed);
      return committed;
    });
    queue = operation.catch(() => {});
    return operation;
  }

  function replace(models, overrides = {}) {
    const replacement = [...models];
    return mutate(current => {
      const activeModelId = overrides.activeModelId ?? (replacement.some(model => model.id === current.activeModelId) ? current.activeModelId : replacement[0]?.id || null);
      const autoNameModelId = replacement.some(model => model.id === current.autoNameModelId) ? current.autoNameModelId : null;
      return { ...current, ...overrides, models: replacement, activeModelId, autoNameModelId };
    }, { type: 'replace', records: replacement });
  }

  return Object.freeze({
    replace,
    upsert(record) {
      return mutate(current => {
        const models = current.models.map(model => model.id === record.id ? { ...model, ...record } : model);
        if (!models.some(model => model.id === record.id)) models.push({ ...record });
        return {
          ...current,
          models,
          activeModelId: models.some(model => model.id === current.activeModelId) ? current.activeModelId : models[0]?.id || null,
          autoNameModelId: models.some(model => model.id === current.autoNameModelId) ? current.autoNameModelId : null
        };
      }, { type: 'upsert', record: { ...record } });
    },
    remove(id) {
      return mutate(current => {
        const models = current.models.filter(model => model.id !== id);
        return {
          ...current,
          models,
          activeModelId: models.some(model => model.id === current.activeModelId) ? current.activeModelId : models[0]?.id || null,
          autoNameModelId: models.some(model => model.id === current.autoNameModelId) ? current.autoNameModelId : null
        };
      }, { type: 'remove', id });
    },
    select(id) {
      return mutate(current => {
        if (!current.models.some(model => model.id === id)) throw new Error('Unknown model.');
        return { ...current, activeModelId: id };
      }, { type: 'select', id });
    }
  });
}
