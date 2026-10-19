const ALLOWED_TYPES = new Set([
  'openclaw-app',
  'openclaw-module',
  'external-agent',
  'generic-web-app',
]);

const ALLOWED_INTEGRATIONS = new Set([
  'proxy',
  'native',
  'link',
  'adapter',
]);

const ID_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;

function validateManifest(m, fileName) {
  const errors = [];

  if (!m || typeof m !== 'object') {
    return { valid: false, errors: ['Manifest must be an object'] };
  }

  if (typeof m.id !== 'string') {
    errors.push('Missing required field: id');
  } else if (!ID_PATTERN.test(m.id)) {
    errors.push(`Invalid id "${m.id}": must start with lowercase letter, contain only lowercase letters/numbers/hyphens, and be 2-32 chars`);
  }

  if (typeof m.displayName !== 'string' || m.displayName.length === 0) {
    errors.push('Missing required field: displayName');
  }

  if (typeof m.mountPath !== 'string') {
    errors.push('Missing required field: mountPath');
  } else if (!m.mountPath.startsWith('/apps/')) {
    errors.push(`Invalid mountPath "${m.mountPath}": must start with "/apps/"`);
  }

  if (typeof m.integration !== 'string') {
    errors.push('Missing required field: integration');
  } else if (!ALLOWED_INTEGRATIONS.has(m.integration)) {
    errors.push(`Invalid integration "${m.integration}": must be one of ${Array.from(ALLOWED_INTEGRATIONS).join(', ')}`);
  }

  if (typeof m.type !== 'string') {
    errors.push('Missing required field: type');
  } else if (!ALLOWED_TYPES.has(m.type)) {
    errors.push(`Invalid type "${m.type}": must be one of ${Array.from(ALLOWED_TYPES).join(', ')}`);
  }

  if (m.integration === 'proxy' || m.integration === 'adapter') {
    if (typeof m.baseUrl !== 'string' || m.baseUrl.length === 0) {
      errors.push(`integration "${m.integration}" requires baseUrl`);
    } else if (!isAllowedBaseUrl(m.baseUrl)) {
      errors.push(`baseUrl "${m.baseUrl}" is not allowed: only localhost, 127.0.0.1, or whitelisted hosts`);
    }
  }

  if (m.integration === 'native') {
    // entry/serverEntry are optional - native-loader auto-discovers modules
    if (m.entry !== undefined && (typeof m.entry !== 'string' || m.entry.length === 0)) {
      errors.push('integration "native" entry must be a non-empty string if provided');
    }
    if (m.serverEntry !== undefined && (typeof m.serverEntry !== 'string' || m.serverEntry.length === 0)) {
      errors.push('integration "native" serverEntry must be a non-empty string if provided');
    }
  }

  if (m.capabilities !== undefined && !Array.isArray(m.capabilities)) {
    errors.push('capabilities must be an array of strings');
  }

  if (m.showInNav !== undefined && typeof m.showInNav !== 'boolean') {
    errors.push('showInNav must be a boolean');
  }

  if (m.nativeReady !== undefined && typeof m.nativeReady !== 'boolean') {
    errors.push('nativeReady must be a boolean');
  }

  if (m.order !== undefined && (typeof m.order !== 'number' || !Number.isFinite(m.order))) {
    errors.push('order must be a finite number');
  }

  const valid = errors.length === 0;
  if (!valid) {
    console.warn(`[manifest-schema] Invalid manifest ${fileName || m.id || '(unknown)'}:`);
    for (const err of errors) {
      console.warn(`  - ${err}`);
    }
  }

  return { valid, errors };
}

function isAllowedBaseUrl(url) {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname;
    return (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname.endsWith('.local') ||
      isPrivateIP(hostname)
    );
  } catch {
    return false;
  }
}

function isPrivateIP(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some(p => isNaN(p) || p < 0 || p > 255)) {
    return false;
  }
  return (
    parts[0] === 10 ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168)
  );
}

module.exports = {
  validateManifest,
  ALLOWED_TYPES,
  ALLOWED_INTEGRATIONS,
  ID_PATTERN,
};
