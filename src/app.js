/**
 * app.js
 * 需要 Node.js v18+ 原生支持 fetch。
 * 如果要在更低版本 Node 运行，请自行引入 node-fetch@2 等库，并替换对应流操作。
 */

const express = require('express');
const { Readable } = require('stream');

/** 
 * 以下两个工具函数，用于在 Node Stream 与 Web Stream 间互转。
 * Node 18+ 已支持 Readable.fromWeb() / Readable.toWeb()。
 * 但若环境不支持，可使用手动转换的实现。
 */
function webReadableToNodeReadable(webStream) {
  return Readable.fromWeb(webStream);
}

function nodeReadableToWebReadable(nodeReadable) {
  return new ReadableStream({
    start(controller) {
      nodeReadable.on('data', (chunk) => {
        controller.enqueue(chunk);
      });
      nodeReadable.on('end', () => {
        controller.close();
      });
      nodeReadable.on('error', (err) => {
        controller.error(err);
      });
    },
  });
}

// ----------------- 配置区域 -----------------
const CUSTOM_DOMAIN = process.env.CUSTOM_DOMAIN || 'example.com';
const MODE = process.env.MODE || 'production';
const TARGET_UPSTREAM = process.env.TARGET_UPSTREAM || '';

// 常见镜像仓库地址
const dockerHub = 'https://registry-1.docker.io';
const routes = {
  // production
  ['docker.' + CUSTOM_DOMAIN]: dockerHub,
  ['quay.' + CUSTOM_DOMAIN]: 'https://quay.io',
  ['gcr.' + CUSTOM_DOMAIN]: 'https://gcr.io',
  ['k8s-gcr.' + CUSTOM_DOMAIN]: 'https://k8s.gcr.io',
  ['k8s.' + CUSTOM_DOMAIN]: 'https://registry.k8s.io',
  ['ghcr.' + CUSTOM_DOMAIN]: 'https://ghcr.io',
  ['cloudsmith.' + CUSTOM_DOMAIN]: 'https://docker.cloudsmith.io',
  ['ecr.' + CUSTOM_DOMAIN]: 'https://public.ecr.aws',

  // staging
  ['docker-staging.' + CUSTOM_DOMAIN]: dockerHub,
};

// 根据 host 决定要转发到哪个上游
function routeByHosts(host) {
  if (routes[host]) {
    return routes[host];
  }
  // 如果是调试模式，并且传了 TARGET_UPSTREAM，就把所有未匹配域名代理到它
  if (MODE === 'debug') {
    return TARGET_UPSTREAM;
  }
  return '';
}

// 解析 Www-Authenticate
function parseAuthenticate(authenticateStr) {
  // 样例：Bearer realm="https://auth.ipv6.docker.com/token",service="registry.docker.io"
  // 用正则匹配 =" 和 " 之间的字符串
  const re = /(?<=\=")(?:\\.|[^"\\])*(?=")/g;
  const matches = authenticateStr.match(re);
  if (!matches || matches.length < 2) {
    throw new Error(`invalid Www-Authenticate Header: ${authenticateStr}`);
  }
  return {
    realm: matches[0],
    service: matches[1],
  };
}

// 用于向 Docker Hub 获取 token
async function fetchToken(wwwAuthenticate, scope, authorization) {
  const url = new URL(wwwAuthenticate.realm);
  if (wwwAuthenticate.service.length) {
    url.searchParams.set('service', wwwAuthenticate.service);
  }
  if (scope) {
    url.searchParams.set('scope', scope);
  }
  const headers = {};
  if (authorization) {
    headers['Authorization'] = authorization;
  }
  return fetch(url, { method: 'GET', headers });
}

// 返回 401 的辅助函数
function responseUnauthorized(url, res) {
  const headers = {};
  if (MODE === 'debug') {
    headers['WWW-Authenticate'] = `Bearer realm="http://${url.host}/v2/auth",service="docker-repository-proxy"`;
  } else {
    headers['WWW-Authenticate'] = `Bearer realm="https://${url.hostname}/v2/auth",service="docker-repository-proxy"`;
  }
  res.set(headers);
  res.status(401).json({ message: 'UNAUTHORIZED' });
}

// 将 fetch 的响应流式写给客户端
async function streamResponse(resp, res) {
  // 先拷贝响应头
  resp.headers.forEach((value, name) => {
    res.setHeader(name, value);
  });
  // 设置响应状态码
  res.status(resp.status);

  // 如果上游有 body，就流式传输到 res
  if (resp.body) {
    const nodeStream = webReadableToNodeReadable(resp.body);
    nodeStream.pipe(res);
  } else {
    // 如果没有 body，直接结束
    res.end();
  }
}

const app = express();

/**
 * 核心代理逻辑中间件
 */
app.use(async (req, res, next) => {
  try {
    const host = req.hostname;
    const upstream = routeByHosts(host);

    // 如果找不到对应的上游，返回 404
    if (!upstream) {
      res.status(404).json({ routes });
      return;
    }

    const isDockerHub = upstream === dockerHub;
    const authorization = req.headers['authorization'];
    const url = new URL(req.url, `http://${req.headers.host}`);

    // 处理 /v2/ 请求，判断是否要校验 401
    if (url.pathname === '/v2/') {
      const newUrl = new URL(upstream + '/v2/');
      const headers = {};
      if (authorization) {
        headers['Authorization'] = authorization;
      }

      const resp = await fetch(newUrl.toString(), {
        method: 'GET',
        headers,
        redirect: 'follow',
      });

      if (resp.status === 401) {
        responseUnauthorized(url, res);
        return;
      }

      // 流式输出给客户端
      await streamResponse(resp, res);
      return;
    }

    // 处理 /v2/auth 获取 Token
    if (url.pathname === '/v2/auth') {
      const newUrl = new URL(upstream + '/v2/');
      const resp = await fetch(newUrl.toString(), {
        method: 'GET',
        redirect: 'follow',
      });

      // 如果返回不是 401，那就把响应直接转给客户端
      if (resp.status !== 401) {
        await streamResponse(resp, res);
        return;
      }

      // 如果返回 401，需要解析 WWW-Authenticate
      const authenticateStr = resp.headers.get('WWW-Authenticate');
      if (!authenticateStr) {
        // 直接转发
        await streamResponse(resp, res);
        return;
      }

      const wwwAuthenticate = parseAuthenticate(authenticateStr);
      let scope = url.searchParams.get('scope');

      // 自动为 dockerHub 补全 "library/"
      // 例如 repository:busybox:pull => repository:library/busybox:pull
      if (scope && isDockerHub) {
        const scopeParts = scope.split(':');
        if (scopeParts.length === 3 && !scopeParts[1].includes('/')) {
          scopeParts[1] = 'library/' + scopeParts[1];
          scope = scopeParts.join(':');
        }
      }

      // 向 Docker Hub 获取 Token
      const tokenResp = await fetchToken(wwwAuthenticate, scope, authorization);
      await streamResponse(tokenResp, res);
      return;
    }

    // 如果是 dockerHub，并且请求路径格式是 /v2/busybox/...，自动补充 library/
    // /v2/busybox/manifests/latest => /v2/library/busybox/manifests/latest
    if (isDockerHub) {
      const pathParts = url.pathname.split('/');
      if (pathParts.length === 5) {
        pathParts.splice(2, 0, 'library');
        const redirectUrl = new URL(url);
        redirectUrl.pathname = pathParts.join('/');
        res.redirect(301, redirectUrl.toString());
        return;
      }
    }

    // -----------------
    // 通用转发逻辑 (大文件拉取/推送)
    // -----------------
    const newUrl = new URL(upstream + url.pathname + url.search);

    // 拷贝原请求头，移除不必要的
    const headers = { ...req.headers };
    headers['host'] = new URL(upstream).host;
    delete headers['accept-encoding'];

    // 构造 fetch 请求体：GET/HEAD 不需要 body，其它则使用流。
    let body;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      body = nodeReadableToWebReadable(req); 
    }

    const fetchOptions = {
      method: req.method,
      headers,
      redirect: 'follow',
      body,
    };

    const upstreamResp = await fetch(newUrl, fetchOptions);

    // 如果上游返回 401，则给客户端返回一个带 WWW-Authenticate 的 401
    if (upstreamResp.status === 401) {
      responseUnauthorized(url, res);
      return;
    }

    // 正常情况下，流式把上游响应转给客户端
    await streamResponse(upstreamResp, res);
  } catch (err) {
    next(err);
  }
});

// 错误处理中间件
app.use((err, req, res, next) => {
  console.error('Internal Error:', err);
  res.status(500).send('Internal Server Error');
});

// 启动服务
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
