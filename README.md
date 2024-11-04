# docker repository proxy

使用ChatGPT从https://github.com/ciiiii/cloudflare-docker-proxy.git转换而来

## 配置说明

通过环境变量进行配置

PORT: 代理服务端口，默认为3000

CUSTOM_DOMAIN: 代理服务域名. 例如设置成: proxy.example.com则各个代理服务域名为

* docker.proxy.example.com -> https://registry-1.docker.io
* quay.proxy.example.com -> https://quay.io
* gcr.proxy.example.com -> https://gcr.io
* k8s-gcr.proxy.example.com -> https://k8s.gcr.io
* k8s.proxy.example.com -> https://registry.k8s.io
* ghcr.proxy.example.com -> https://ghcr.io
* cloudsmith.proxy.example.com -> https://docker.cloudsmith.io
* ecr.proxy.example.com -> https://public.ecr.aws
