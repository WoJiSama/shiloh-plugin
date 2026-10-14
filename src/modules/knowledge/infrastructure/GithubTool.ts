import {AbstractTool} from '../../toolSupport/infrastructure/AbstractTool.js'
function record(value:unknown):Record<string,unknown>{return value&&typeof value==='object'?value as Record<string,unknown>:{}}
export function createGitHubRepoTool(ports:{githubToken:string;fetch:typeof fetch;logger:{info(message:string):void}}){
class GitHubRepoTool extends AbstractTool {
  headers:Record<string,string>
  constructor() {
    super();
    this.name = 'githubRepoTool';
    this.description = '获取GitHub仓库的详细信息，包括基本信息、最近提交、贡献者等';
    this.parameters = {
      type: "object",
      properties: {
        repoUrl: {
          type: 'string',
          description: 'GitHub仓库的URL，例如：https://github.com/username/repo'
        }
      },
      required: ['repoUrl']
    };

    this.headers = {
      'User-Agent': 'GitHub-Repository-Tool',
      'Accept': 'application/vnd.github.v3+json'
    };

    if (ports.githubToken) {
      this.headers['Authorization'] = `token ${ports.githubToken}`;
      // ports.logger.info('[GitHubRepoTool] 已配置 GitHub Token');
    } else {
      ports.logger.info('[GitHubRepoTool] 未配置 GitHub Token，API 限制为 60次/小时');
    }
  }

  async fetchGitHubAPI(apiPath:string):Promise<unknown> {
    const url = `https://api.github.com${apiPath}`;
    
    const response = await ports.fetch(url, {
      method: 'GET',
      headers: this.headers
    });

    const remaining = response.headers.get('x-ratelimit-remaining');
    const limit = response.headers.get('x-ratelimit-limit');
    ports.logger.info(`[API] ${apiPath} -> ${response.status} (剩余: ${remaining}/${limit})`);

    const data:unknown = await response.json();

    // 如果返回的是错误对象
    if (!response.ok) {
      throw new Error(`${record(data).message || response.statusText} (${response.status})`);
    }

    return data;
  }

  parseGitHubUrl(url:string) {
    const regex = /github\.com\/([^\/]+)\/([^\/]+)/;
    const match = url.match(regex);
    if (!match) throw new Error('无效的GitHub仓库URL');
    return { owner: match[1], repo: (match[2] || "").replace(/\.git$/, '').replace(/\?.*$/, '') };
  }

  // 安全获取数据，失败时返回空数组
  async safeGetArray(apiPath:string) {
    try {
      const data = await this.fetchGitHubAPI(apiPath);
      return Array.isArray(data) ? data.map(record) : [];
    } catch (error) {
      console.error(`[安全获取数组] ${apiPath} 失败:`, (error instanceof Error ? error.message : String(error)));
      return [];
    }
  }

  async func(opts:unknown, _e:unknown) {
    const repoUrl=String(record(opts).repoUrl || "");

    if (!repoUrl?.trim()) {
      return { status: 'error', code: 400, message: 'GitHub仓库URL不能为空' };
    }

    try {
      const { owner, repo } = this.parseGitHubUrl(repoUrl);
      const basePath = `/repos/${owner}/${repo}`;

      ports.logger.info(`[GitHubRepoTool] 获取仓库: ${owner}/${repo}`);

      // 获取基本信息（必须成功）
      const repoData = record(await this.fetchGitHubAPI(basePath));

      // 获取其他数据（允许失败）
      const [commitsData, issuesData, pullsData, branchesData, contributorsData] = 
        await Promise.all([
          this.safeGetArray(`${basePath}/commits?per_page=5`),
          this.safeGetArray(`${basePath}/issues?state=open&per_page=100`),
          this.safeGetArray(`${basePath}/pulls?state=open&per_page=100`),
          this.safeGetArray(`${basePath}/branches?per_page=100`),
          this.safeGetArray(`${basePath}/contributors?per_page=5`)
        ]);

      ports.logger.info(`[数据统计] 提交: ${commitsData.length}, Issues: ${issuesData.length}, PR: ${pullsData.length}, 分支: ${branchesData.length}, 贡献者: ${contributorsData.length}`);

      // 格式化提交信息
      const commits = commitsData.map((commit, index) => ({
        [`提交${index + 1}`]: {
          消息: String(record(commit.commit).message||'').split('\n')[0] || '', // 只取第一行
          作者: record(record(commit.commit).author).name || '',
          日期: record(record(commit.commit).author).date 
            ? new Date(String(record(record(commit.commit).author).date)).toLocaleString('zh-CN') 
            : '',
          SHA: String(commit.sha||'').substring(0, 7) || '',
        }
      }));

      // 格式化贡献者信息
      const contributors = contributorsData.map(c => ({
        用户名: c.login || '',
        贡献数: c.contributions || 0,
        主页: c.html_url || '',
      }));

      return {
        status: 'success',
        data: {
          基本信息: {
            仓库名称: repoData.name,
            描述: repoData.description || '无描述',
            创建时间: new Date(String(repoData.created_at)).toLocaleString('zh-CN'),
            最后更新: new Date(String(repoData.updated_at)).toLocaleString('zh-CN'),
            默认分支: repoData.default_branch,
            Star数量: repoData.stargazers_count,
            Fork数量: repoData.forks_count,
            Watch数量: repoData.subscribers_count,
            开放Issues: repoData.open_issues_count, // 直接用仓库信息中的数据
            分支数量: branchesData.length,
            语言: repoData.language,
            URL: repoData.html_url,
            是否归档: repoData.archived,
            许可证: record(repoData.license).name || '未指定',
          },
          最近提交: commits,
          主要贡献者: contributors,
        }
      };
    } catch (error) {
      console.error('[GitHubRepoTool] 错误:', error);
      return {
        status: 'error',
        code: 500,
        message: `获取GitHub仓库信息失败: ${(error instanceof Error ? error.message : String(error))}`
      };
    }
  }
}

return GitHubRepoTool
}
