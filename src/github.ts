import { StaleHeadError, type Change, type Remote, type RemoteFile } from './sync';

export interface GitHubConfig {
  owner: string;
  repo: string;
  branch: string;
  token: string;
}

export class GitHubError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const HINTS: Record<number, string> = {
  401: 'GitHub rejected the token (expired or mistyped?)',
  403: 'The token is missing Contents read/write access to this repo',
  404: 'Repository not found. Check the name and that the token can access it',
};

/** Syncs through the GitHub REST API. Every sync is one commit, so the repo history doubles as a backup. */
export class GitHubRemote implements Remote {
  constructor(private cfg: GitHubConfig) {}

  /** Throws if the repo can't be reached with this token; returns a warning if the notes would be public. */
  async check(): Promise<string | undefined> {
    const repo = await this.api<{ private: boolean }>('GET', '');
    if (!repo.private) return 'Heads up: this repository is public, so anyone can read your notes.';
  }

  async head(): Promise<string | null> {
    try {
      return (await this.api<{ object: { sha: string } }>('GET', `/git/ref/heads/${this.cfg.branch}`)).object.sha;
    } catch (e) {
      if (!(e instanceof GitHubError)) throw e;
      if (e.status === 409) return null; // empty repository
      if (e.status === 404) {
        await this.api('GET', ''); // throws if the repo itself is missing
        throw new Error(`Branch "${this.cfg.branch}" not found in ${this.cfg.owner}/${this.cfg.repo}`);
      }
      throw e;
    }
  }

  async list(head: string): Promise<RemoteFile[]> {
    const commit = await this.api<{ tree: { sha: string } }>('GET', `/git/commits/${head}`);
    const tree = await this.api<{ tree: { path: string; type: string; sha: string }[]; truncated: boolean }>(
      'GET',
      `/git/trees/${commit.tree.sha}?recursive=1`,
    );
    if (tree.truncated) throw new Error('The notes repository is too large to list');
    return tree.tree.filter((e) => e.type === 'blob').map(({ path, sha }) => ({ path, sha }));
  }

  async read(sha: string): Promise<string> {
    const blob = await this.api<{ content: string; encoding: string }>('GET', `/git/blobs/${sha}`);
    if (blob.encoding !== 'base64') return blob.content;
    const binary = atob(blob.content.replace(/\s/g, ''));
    return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
  }

  async commit(parent: string | null, changes: Change[], message: string): Promise<string> {
    parent ??= await this.init();
    const base = await this.api<{ tree: { sha: string } }>('GET', `/git/commits/${parent}`);
    const tree = await this.api<{ sha: string }>('POST', '/git/trees', {
      base_tree: base.tree.sha,
      tree: changes.map(({ path, content }) => ({
        path,
        mode: '100644',
        type: 'blob',
        ...(content === null ? { sha: null } : { content }),
      })),
    });
    const commit = await this.api<{ sha: string }>('POST', '/git/commits', {
      message,
      tree: tree.sha,
      parents: [parent],
    });
    try {
      await this.api('PATCH', `/git/refs/heads/${this.cfg.branch}`, { sha: commit.sha });
    } catch (e) {
      if (e instanceof GitHubError && e.status === 422) throw new StaleHeadError();
      throw e;
    }
    return commit.sha;
  }

  /** The Git Data API can't write to an empty repo, so the first commit goes through the contents API. */
  private async init(): Promise<string> {
    const res = await this.api<{ commit: { sha: string } }>('PUT', '/contents/README.md', {
      message: 'Start notes',
      content: btoa('# Notes\n\nWritten with Jot.\n'),
      branch: this.cfg.branch,
    });
    return res.commit.sha;
  }

  private async api<T>(method: string, path: string, body?: unknown): Promise<T> {
    const { owner, repo, token } = this.cfg;
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}${path}`, {
      method,
      cache: 'no-store',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new GitHubError(res.status, HINTS[res.status] ?? data.message ?? `GitHub error ${res.status}`);
    }
    return res.json();
  }
}
