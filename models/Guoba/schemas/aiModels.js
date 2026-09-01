import { AI_PROVIDER_DEFINITIONS } from "../../../utils/guobaAiProviderConfig.js"

function makeProviderSchemas(definition) {
  const schemas = [
    {
      field: "name",
      label: "名称",
      component: "Input",
      required: true,
      componentProps: { placeholder: `例如 ${definition.modelPlaceholder}` }
    },
    {
      field: "apiUrl",
      label: "URL",
      component: "Input",
      required: true,
      componentProps: { placeholder: definition.urlPlaceholder }
    },
    {
      field: "model",
      label: "模型名",
      component: "Input",
      required: true,
      componentProps: { placeholder: definition.modelPlaceholder }
    },
    {
      field: "apiKey",
      label: "API Key",
      component: "InputPassword",
      required: true,
      componentProps: { placeholder: "sk-xxxxx" }
    }
  ]

  for (const extra of definition.extraFields || []) {
    schemas.push({
      field: extra.panelField,
      label: extra.label || (extra.panelField === "size" ? "图片尺寸" : extra.panelField),
      component: "Input",
      componentProps: {
        placeholder: extra.placeholder || (definition.configKey === "imageGenerationAiConfig"
          ? "Seedream 可填 2K，OpenAI 常见为 1024x1024"
          : "")
      }
    })
  }

  schemas.push({
    field: "priority",
    label: "优先级",
    component: "InputNumber",
    componentProps: { min: 1, max: 99, step: 1, placeholder: "1" },
    required: true
  })

  return schemas
}

function makeAiProviderBlock(definition) {
  return [
    {
      component: "Divider",
      label: definition.title
    },
    {
      field: `${definition.configKey}.providers`,
      label: definition.listLabel,
      component: "GSubForm",
      componentProps: {
        multiple: true,
        modalProps: { title: definition.title },
        schemas: makeProviderSchemas(definition)
      },
      bottomHelpMessage: `${definition.usageHint}。可配置多个模型，priority 数字越小越优先；保存时会把第一个优先级同步到旧字段，现有功能继续兼容。文生图已支持失败后自动尝试下一个候选；其他场景当前用于面板切换优先模型`
    }
  ]
}

export default [
  {
    component: "SOFT_GROUP_BEGIN",
    label: "AI 模型配置"
  },
  ...AI_PROVIDER_DEFINITIONS.flatMap(makeAiProviderBlock)
]
