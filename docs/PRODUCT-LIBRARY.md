# 产品推广知识库

产品管理按产品组织可维护的推广资料，不再只有产品名称。每个产品包含：

- 产品资料：定位、目标人群、产品介绍、公开入口、版本/上架状态说明。
- 推广文档：Skill交接简报、原始素材清单、策略、待确认事项、更正说明等。
- 素材库：图标、品牌素材、产品截图、商店截图及其他文件，支持预览、下载、更新和归档。

事实资料保留来源与版本。导入历史说明不等于重新验证当前商店版本；发布前应结合较新的更正记录核对。类型为“产品截图”的历史登录图不自动变为“商店截图”。

## AI 接口

所有接口使用现有 Bearer 认证。产品基础信息继续使用 `/api/v1/products`。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/v1/products/{product_id}/library` | 按产品列出文档/素材，支持kind、q、limit、offset |
| POST | 同上 | 新增文档或上传素材，必须提供Idempotency-Key |
| GET | `/api/v1/products/{product_id}/library/{entry_id}` | 读取一条资料 |
| PATCH | 同上 | 携带当前version更新正文、分类、文件或归档状态 |
| GET | `/api/v1/products/{product_id}/library/{entry_id}/history` | 查看版本历史 |
| GET | `/api/v1/products/{product_id}/library/{entry_id}/download` | 下载文档或素材文件 |

文档新增示例（正文需来自实际资料）：

```json
{
  "kind": "document",
  "title": "产品推广简报",
  "category": "brief",
  "body": "# 产品推广简报\n\n有来源的产品事实……",
  "source_path": "App-Promo-Handoff-example/App-Promo-Brief-example.md"
}
```

素材新增使用 `kind: "asset"`，包含 `title/category/body/source_path/filename/mime_type/content_base64`。单个文件最多10MB，base64不作为GET列表的返回字段。更新时使用PATCH并附version；替换素材后保留旧版本。归档用 `status: "archived"`，不永久删除。

同一产品下的资料彼此独立维护，跨产品entry_id不能直接复用。读取文档后由外部AI完成策划，系统本身不生成AI内容。
