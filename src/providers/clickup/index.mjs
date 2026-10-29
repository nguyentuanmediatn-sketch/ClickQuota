import { clickupPool, WorkspacePool } from './pool.mjs';
import {
  CLICKUP_MODELS,
  CLICKUP_ALIAS_MODELS,
  handleClickUpRequest,
  resolveClickUpModel,
} from './upstream.mjs';

export class ClickUpProvider {
  constructor(config = {}) {
    this.name = 'clickup';
    this.label = 'ClickUp AI Multi-Workspace Pool';
    this.pool = clickupPool;
    this.config = config;
  }

  isModel(model) {
    if (!model || typeof model !== 'string') return false;
    const m = model.toLowerCase().trim().replace(/[-_]thinking$/i, '');
    if (m.endsWith('-cl') || m.endsWith('_cl')) return true;
    if (m.startsWith('clickup/') || m.startsWith('cu/')) return true;
    return CLICKUP_MODELS.some((id) => id.toLowerCase() === m);
  }

  normalizeModel(model) {
    return resolveClickUpModel(model);
  }

  getModels() {
    return CLICKUP_MODELS.map((id) => {
      const isAlias = CLICKUP_ALIAS_MODELS.has(id);
      return {
        id,
        object: 'model',
        owned_by: 'clickup',
        provider: 'clickup',
        // §207: client phải phân biệt được model thật với alias gateway.
        // Alias vẫn phục vụ được (gateway ánh xạ lại), nhưng raw id là 500 ở upstream.
        alias: isAlias,
        ...(isAlias ? { aliasOf: resolveClickUpModel(id) } : {}),
      };
    });
  }

  async getStatus() {
    return {
      summary: this.pool.getPoolSummary(),
      workspaces: this.pool.getSnapshot(),
    };
  }

  async handleRequest(ctx) {
    return await handleClickUpRequest(ctx);
  }
}

export const clickupProvider = new ClickUpProvider();
export {
  clickupPool,
  WorkspacePool,
  CLICKUP_MODELS,
  handleClickUpRequest,
  resolveClickUpModel,
};
