# 本地 embedding 模型

`bge-small-zh-v1.5/` 是 BAAI bge-small-zh-v1.5 的 ONNX int8 版本（Xenova 转换），
给长程记忆的向量召回用。

> 该目录**不入库**（见 `si/.gitignore`），和其他组件一样首次按需下载：
> 第一次压缩上下文需要写记忆时，主进程按 `app/components.json` 的 `memory.files`
> 从 `hf-mirror.com`（失败回退 `huggingface.co`）下载，进度显示在设置页底栏。

- 来源：https://huggingface.co/Xenova/bge-small-zh-v1.5
  （下载时先走 `https://hf-mirror.com`，HuggingFace 直连不通）
- 文件：`tokenizer.json`、`config.json`、`onnx/model_quantized.onnx`
- 体积：约 23MB
- 维度：512（CLS pooling + L2 归一化）
- 许可：MIT（BAAI）

换模型时记得同步改 `app/memory/embed.js` 的 `MODEL_NAME`、`app/components.json`
的 `memory` 段，并重新生成全部向量（`vectors.embed_model` 会记录来源）。

