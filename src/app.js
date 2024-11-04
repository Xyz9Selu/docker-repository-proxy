const express = require('express');
const getRawBody = require('raw-body');

const app = express();

const dockerHub = "https://registry-1.docker.io";

const CUSTOM_DOMAIN = process.env.CUSTOM_DOMAIN || 'example.com';
const MODE = process.env.MODE || 'production';
const TARGET_UPSTREAM = process.env.TARGET_UPSTREAM || '';

const routes = {
  // production
  ["docker." + CUSTOM_DOMAIN]: dockerHub,
  ["quay." + CUSTOM_DOMAIN]: "https://quay.io",
  ["gcr." + CUSTOM_DOMAIN]: "https://gcr.io",
  ["k8s-gcr." + CUSTOM_DOMAIN]: "https://k8s.gcr.io",
  ["k8s." + CUSTOM_DOMAIN]: "https://registry.k8s.io",
  ["ghcr." + CUSTOM_DOMAIN]: "https://ghcr.io",
  ["cloudsmith." + CUSTOM_DOMAIN]: "https://docker.cloudsmith.io",
  ["ecr." + CUSTOM_DOMAIN]: "https://public.ecr.aws",

  // staging
  ["docker-staging." + CUSTOM_DOMAIN]: dockerHub,
};

function routeByHosts(host) {
  if (routes[host]) {
    return routes[host];
  }
  if (MODE == "debug") {
    return TARGET_UPSTREAM;
  }
  return "";
}

app.use(async (req, res, next) => {
  const host = req.hostname;
  const upstream = routeByHosts(host);

  if (upstream === "") {
    res.status(404).json({ routes: routes });
    return;
  }

  const isDockerHub = upstream == dockerHub;
  const authorization = req.headers['authorization'];

  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === "/v2/") {
    const newUrl = new URL(upstream + "/v2/");
    const headers = {};
    if (authorization) {
      headers['Authorization'] = authorization;
    }

    try {
      const resp = await fetch(newUrl.toString(), {
        method: 'GET',
        headers: headers,
        redirect: 'follow',
      });

      if (resp.status === 401) {
        responseUnauthorized(url, res);
        return;
      }

      // Copy the response headers and body.
      resp.headers.forEach((value, name) => res.setHeader(name, value));
      res.status(resp.status);
      const body = await resp.arrayBuffer();
      res.send(Buffer.from(body));
      return;
    } catch (err) {
      next(err);
      return;
    }
  }

  // For /v2/auth
  if (url.pathname === "/v2/auth") {
    const newUrl = new URL(upstream + "/v2/");
    try {
      const resp = await fetch(newUrl.toString(), {
        method: 'GET',
        redirect: 'follow',
      });

      if (resp.status !== 401) {
        // Copy the response headers and body.
        resp.headers.forEach((value, name) => res.setHeader(name, value));
        res.status(resp.status);
        const body = await resp.arrayBuffer();
        res.send(Buffer.from(body));
        return;
      }

      const authenticateStr = resp.headers.get("WWW-Authenticate");
      if (authenticateStr === null) {
        // Copy the response headers and body.
        resp.headers.forEach((value, name) => res.setHeader(name, value));
        res.status(resp.status);
        const body = await resp.arrayBuffer();
        res.send(Buffer.from(body));
        return;
      }

      const wwwAuthenticate = parseAuthenticate(authenticateStr);
      let scope = url.searchParams.get("scope");
      // autocomplete repo part into scope for DockerHub library images
      // Example: repository:busybox:pull => repository:library/busybox:pull
      if (scope && isDockerHub) {
        let scopeParts = scope.split(":");
        if (scopeParts.length == 3 && !scopeParts[1].includes("/")) {
          scopeParts[1] = "library/" + scopeParts[1];
          scope = scopeParts.join(":");
        }
      }
      const tokenResp = await fetchToken(wwwAuthenticate, scope, authorization);

      // Copy the response headers and body.
      tokenResp.headers.forEach((value, name) => res.setHeader(name, value));
      res.status(tokenResp.status);
      const body = await tokenResp.arrayBuffer();
      res.send(Buffer.from(body));
      return;

    } catch (err) {
      next(err);
      return;
    }
  }

  // redirect for DockerHub library images
  // Example: /v2/busybox/manifests/latest => /v2/library/busybox/manifests/latest
  if (isDockerHub) {
    const pathParts = url.pathname.split("/");
    if (pathParts.length == 5) {
      pathParts.splice(2, 0, "library");
      const redirectUrl = new URL(url);
      redirectUrl.pathname = pathParts.join("/");
      res.redirect(301, redirectUrl.toString());
      return;
    }
  }

  // forward requests
  const newUrl = new URL(upstream + url.pathname + url.search);
  const headers = { ...req.headers };
  headers['host'] = new URL(upstream).host;
  delete headers['accept-encoding'];

  let body;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    body = await getRawBody(req);
  }

  const options = {
    method: req.method,
    headers: headers,
    redirect: 'follow',
    body: body,
  };

  try {
    const resp = await fetch(newUrl, options);

    if (resp.status === 401) {
      responseUnauthorized(url, res);
      return;
    }

    // Copy the response headers and body.
    resp.headers.forEach((value, name) => res.setHeader(name, value));
    res.status(resp.status);
    const responseBody = await resp.arrayBuffer();
    res.send(Buffer.from(responseBody));
    return;
  } catch (err) {
    next(err);
    return;
  }

});

function parseAuthenticate(authenticateStr) {
  // sample: Bearer realm="https://auth.ipv6.docker.com/token",service="registry.docker.io"
  // match strings after =" and before "
  const re = /(?<=\=")(?:\\.|[^"\\])*(?=")/g;
  const matches = authenticateStr.match(re);
  if (matches == null || matches.length < 2) {
    throw new Error(`invalid Www-Authenticate Header: ${authenticateStr}`);
  }
  return {
    realm: matches[0],
    service: matches[1],
  };
}

async function fetchToken(wwwAuthenticate, scope, authorization) {
  const url = new URL(wwwAuthenticate.realm);
  if (wwwAuthenticate.service.length) {
    url.searchParams.set("service", wwwAuthenticate.service);
  }
  if (scope) {
    url.searchParams.set("scope", scope);
  }
  const headers = {};
  if (authorization) {
    headers['Authorization'] = authorization;
  }
  return await fetch(url, { method: "GET", headers: headers });
}

function responseUnauthorized(url, res) {
  const headers = {};
  if (MODE == "debug") {
    headers['WWW-Authenticate'] = `Bearer realm="http://${url.host}/v2/auth",service="cloudflare-docker-proxy"`;
  } else {
    headers['WWW-Authenticate'] = `Bearer realm="https://${url.hostname}/v2/auth",service="cloudflare-docker-proxy"`;
  }
  res.set(headers);
  res.status(401).json({ message: "UNAUTHORIZED" });
}

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).send('Internal Server Error');
});
