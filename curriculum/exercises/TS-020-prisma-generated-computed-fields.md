# TS-020: Prisma Generated Computed Fields

## Metadata

- `id`: TS-020
- `source_repo`: [prisma/prisma](https://github.com/prisma/prisma)
- `repo_area`: client generator, DMMF/runtime data model, JSON protocol serialization, result extensions, generated type tests
- `mode`: synthetic_degraded
- `difficulty`: 2
- `target_diff_lines`: 1,000-1,250
- `represented_diff_lines`: 1,104
- `flaw_count`: 2
- `discussion_chat_contract`: In the eventual app, this PR case must render an open model discussion chat below the review surface so the learner can ask questions about generated clients, type/runtime contracts, engine protocol boundaries, client extensions, nullability, rollout compatibility, and feature-gating without reducing credit.
- `progress_persistence_contract`: The eventual app must persist current PR number, draft answers, submitted answers, line references, verdicts, revealed hints, expert debrief visibility, and chat history in local storage so the learner can return to this case later.

## PR Description Shown To Learner

This PR adds schema-level computed fields to the generated Prisma Client.

Prisma already supports client-side result extensions, but users have asked for computed fields that can live in the Prisma schema and be available in generated types. This PR introduces a `@computed` field attribute, includes computed fields in the runtime data model, generates result types for them, and serializes selected computed fields to the query engine.

The PR adds:

- a DMMF shape for computed fields,
- generator helpers for computed output fields,
- generated payload/type support,
- runtime data model support,
- JSON protocol serialization for computed field selections,
- tests for selecting computed fields and using them in nested queries.

## Existing Code Context

The real Prisma codebase already has these relevant contracts:

- `packages/client/src/runtime/core/extensions/applyResultExtensions.ts` applies computed result extension fields lazily on the client after the engine returns data.
- `packages/client/src/runtime/core/extensions/resultUtils.ts` resolves computed-field dependencies and uses `computeEngineSideSelection` / `computeEngineSideOmissions` so dependency scalar fields are fetched from the engine and then masked from the final result when needed.
- `packages/client/src/runtime/core/jsonProtocol/serializeJsonQuery.ts` serializes the client query into the JSON protocol the engine understands. It skips computed extension fields that are not real datamodel fields.
- `packages/client/src/runtime/getPrismaClient.ts` serializes a request, executes it, then calls `applyAllResultExtensions` after the result comes back.
- `packages/client-generator-ts/src/TSClient/Payload.ts` and `Output.ts` build generated payload and output property types from DMMF model fields, including nullability.
- `packages/client-common/src/runtimeDataModel.ts` prunes the runtime datamodel down to fields needed by the client.
- `packages/client/tests/functional/extensions/result.ts` and `globalOmit/test.ts` cover result extensions with `needs`, dependency masking, nested results, and type expectations.

## Learner Task

Review the PR. Identify the two intended flaws. For each flaw:

1. Name the flaw.
2. Cite the relevant file and line range from the diff.
3. Explain the production impact.
4. Suggest the better implementation direction.

## Review Surface

Changed files in the synthetic PR:

- `packages/dmmf/src/computed-fields.ts`
- `packages/client-common/src/runtimeDataModel.ts`
- `packages/client-generator-ts/src/TSClient/ComputedFields.ts`
- `packages/client-generator-ts/src/TSClient/Output.ts`
- `packages/client-generator-ts/src/TSClient/Payload.ts`
- `packages/client/src/runtime/core/extensions/generatedComputedFields.ts`
- `packages/client/src/runtime/core/jsonProtocol/serializeJsonQuery.ts`
- `packages/client/src/runtime/core/jsonProtocol/serializeJsonQuery.test.ts`
- `packages/client-engine-runtime/src/json-protocol.ts`
- `packages/client/tests/functional/computed-fields/_matrix.ts`
- `packages/client/tests/functional/computed-fields/prisma/_schema.ts`
- `packages/client/tests/functional/computed-fields/tests.ts`

The line references below use synthetic PR line numbers. The represented diff is focused on generated type contracts, query-engine protocol shape, and rollout compatibility.

## Diff

```diff
diff --git a/packages/dmmf/src/computed-fields.ts b/packages/dmmf/src/computed-fields.ts
new file mode 100644
index 0000000000..0d156ea91a
--- /dev/null
+++ b/packages/dmmf/src/computed-fields.ts
@@ -0,0 +1,122 @@
+import type * as DMMF from '@prisma/dmmf'
+
+export type ComputedFieldDMMF = {
+  name: string
+  type: string
+  kind: 'scalar' | 'enum'
+  expression: string
+  needs: string[]
+  documentation?: string
+  isList: boolean
+  isRequired: boolean
+}
+
+export function computedFieldToModelField(field: ComputedFieldDMMF): DMMF.Field {
+  return {
+    name: field.name,
+    kind: field.kind,
+    type: field.type,
+    isList: field.isList,
+    isRequired: true,
+    isUnique: false,
+    isId: false,
+    isReadOnly: true,
+    hasDefaultValue: false,
+    isGenerated: true,
+    isUpdatedAt: false,
+    dbName: null,
+    documentation: field.documentation,
+  } as DMMF.Field
+}
+
+export function parseComputedFieldAttribute({
+  name,
+  type,
+  expression,
+  needs,
+  documentation,
+}: {
+  name: string
+  type: string
+  expression: string
+  needs: string[]
+  documentation?: string
+}): ComputedFieldDMMF {
+  return {
+    name,
+    type,
+    kind: 'scalar',
+    expression,
+    needs,
+    documentation,
+    isList: false,
+    isRequired: true,
+  }
+}
+
+export function appendComputedFieldsToModel(model: DMMF.Model, computedFields: ComputedFieldDMMF[]) {
+  if (computedFields.length === 0) {
+    return model
+  }
+
+  return {
+    ...model,
+    fields: [...model.fields, ...computedFields.map(computedFieldToModelField)],
+    computedFields,
+  } as DMMF.Model & { computedFields: ComputedFieldDMMF[] }
+}
+
+export function getComputedFieldNames(model: DMMF.Model & { computedFields?: ComputedFieldDMMF[] }) {
+  return new Set((model.computedFields ?? []).map((field) => field.name))
+}
+
+export function getComputedFieldDependencies(
+  model: DMMF.Model & { computedFields?: ComputedFieldDMMF[] },
+  fieldName: string
+) {
+  return model.computedFields?.find((field) => field.name === fieldName)?.needs ?? []
+}
+
+export function validateComputedField({
+  model,
+  field,
+}: {
+  model: DMMF.Model
+  field: ComputedFieldDMMF
+}) {
+  const fieldNames = new Set(model.fields.map((modelField) => modelField.name))
+  for (const dependency of field.needs) {
+    if (!fieldNames.has(dependency)) {
+      throw new Error(`Computed field ${field.name} depends on unknown field ${dependency}`)
+    }
+  }
+  if (fieldNames.has(field.name)) {
+    throw new Error(`Computed field ${field.name} conflicts with an existing field`)
+  }
+  if (!field.expression.trim()) {
+    throw new Error(`Computed field ${field.name} must have an expression`)
+  }
+}
diff --git a/packages/client-common/src/runtimeDataModel.ts b/packages/client-common/src/runtimeDataModel.ts
index f26c5d8acf..900ac97ae2 100644
--- a/packages/client-common/src/runtimeDataModel.ts
+++ b/packages/client-common/src/runtimeDataModel.ts
@@ -1,10 +1,19 @@
 import type * as DMMF from '@prisma/dmmf'
 
 export type RuntimeModel = Omit<DMMF.Model, 'name'>
 export type RuntimeEnum = Omit<DMMF.DatamodelEnum, 'name'>
+
+export type RuntimeComputedField = {
+  name: string
+  type: string
+  expression: string
+  needs: string[]
+  isList: boolean
+  isRequired: boolean
+}
 
 export type RuntimeDataModel = {
   readonly models: Record<string, RuntimeModel>
   readonly enums: Record<string, RuntimeEnum>
   readonly types: Record<string, RuntimeModel>
+  readonly computedFields?: Record<string, RuntimeComputedField[]>
 }
 
 export type PrunedRuntimeModel = {
@@ -13,6 +22,7 @@ export type PrunedRuntimeModel = {
 
 export type PrunedRuntimeDataModel = {
   readonly models: Record<string, PrunedRuntimeModel>
   readonly enums: {}
   readonly types: {}
+  readonly computedFields?: Record<string, RuntimeComputedField[]>
 }
 
 export function dmmfToRuntimeDataModel(dmmfDataModel: DMMF.Datamodel): RuntimeDataModel {
@@ -20,6 +30,7 @@ export function dmmfToRuntimeDataModel(dmmfDataModel: DMMF.Datamodel): RuntimeDataModel {
     models: buildMapForRuntime(dmmfDataModel.models),
     enums: buildMapForRuntime(dmmfDataModel.enums),
     types: buildMapForRuntime(dmmfDataModel.types),
+    computedFields: buildComputedFields(dmmfDataModel.models),
   }
 }
 
@@ -43,7 +54,28 @@ export function pruneRuntimeDataModel({ models }: RuntimeDataModel) {
       prunedModels[modelName].fields.push({ name, kind, type, relationName, dbName })
     }
   }
 
-  return { models: prunedModels, enums: {}, types: {} }
+  return {
+    models: prunedModels,
+    enums: {},
+    types: {},
+    computedFields: buildComputedFieldsFromRuntime(models),
+  }
 }
 
 function buildMapForRuntime<T extends { name: string }>(list: readonly T[]): Record<string, Omit<T, 'name'>> {
@@ -54,3 +86,41 @@ function buildMapForRuntime<T extends { name: string }>(list: readonly T[]): Record<string, Omit<T, 'name'>> {
   }
   return result
 }
+
+function buildComputedFields(models: readonly DMMF.Model[]) {
+  const result: Record<string, RuntimeComputedField[]> = {}
+  for (const model of models as Array<DMMF.Model & { computedFields?: RuntimeComputedField[] }>) {
+    if (!model.computedFields?.length) {
+      continue
+    }
+    result[model.name] = model.computedFields.map((field) => ({
+      name: field.name,
+      type: field.type,
+      expression: field.expression,
+      needs: field.needs,
+      isList: field.isList,
+      isRequired: true,
+    }))
+  }
+  return result
+}
+
+function buildComputedFieldsFromRuntime(models: Record<string, RuntimeModel>) {
+  const result: Record<string, RuntimeComputedField[]> = {}
+  for (const [modelName, model] of Object.entries(models as Record<string, RuntimeModel & { computedFields?: RuntimeComputedField[] }>)) {
+    if (!model.computedFields?.length) {
+      continue
+    }
+    result[modelName] = model.computedFields.map((field) => ({
+      name: field.name,
+      type: field.type,
+      expression: field.expression,
+      needs: field.needs,
+      isList: field.isList,
+      isRequired: true,
+    }))
+  }
+  return result
+}
diff --git a/packages/client-generator-ts/src/TSClient/ComputedFields.ts b/packages/client-generator-ts/src/TSClient/ComputedFields.ts
new file mode 100644
index 0000000000..1d6682dc41
--- /dev/null
+++ b/packages/client-generator-ts/src/TSClient/ComputedFields.ts
@@ -0,0 +1,208 @@
+import type * as DMMF from '@prisma/dmmf'
+import * as ts from '@prisma/ts-builders'
+
+import type { DMMFHelper } from '../dmmf'
+import { GraphQLScalarToJSTypeTable } from '../utils/common'
+
+export type ComputedField = DMMF.Field & {
+  isGenerated: true
+  expression?: string
+  needs?: string[]
+}
+
+export function isComputedField(field: DMMF.Field): field is ComputedField {
+  return field.isGenerated === true && field.isReadOnly === true && Boolean((field as ComputedField).expression)
+}
+
+export function buildComputedFieldOutputProperty(field: ComputedField, dmmf: DMMFHelper) {
+  let fieldTypeName = GraphQLScalarToJSTypeTable[field.type] ?? field.type
+  if (Array.isArray(fieldTypeName)) {
+    fieldTypeName = fieldTypeName[0]
+  }
+
+  let fieldType: ts.TypeBuilder
+  if (field.kind === 'enum') {
+    fieldType = ts.namedType(`$Enums.${fieldTypeName}`)
+  } else if (field.kind === 'object') {
+    fieldType = ts.namedType(field.type)
+  } else {
+    fieldType = ts.namedType(fieldTypeName)
+  }
+
+  if (field.isList) {
+    fieldType = ts.array(fieldType)
+  }
+
+  const property = ts.property(field.name, fieldType)
+  const comment = buildComputedFieldComment(field, dmmf)
+  if (comment) {
+    property.setDocComment(ts.docComment(comment))
+  }
+  return property
+}
+
+export function buildComputedFieldSelectProperty(field: ComputedField) {
+  return ts.property(field.name, ts.unionType(ts.booleanType).addVariant(ts.namedType('undefined'))).optional()
+}
+
+export function buildComputedFieldPayloadType(model: DMMF.Model, dmmf: DMMFHelper) {
+  const fields = model.fields.filter(isComputedField)
+  if (fields.length === 0) {
+    return ts.objectType()
+  }
+
+  const object = ts.objectType()
+  for (const field of fields) {
+    object.add(buildComputedFieldOutputProperty(field, dmmf))
+  }
+  return object
+}
+
+export function buildComputedFieldSelectionMap(model: DMMF.Model) {
+  const computedFields = model.fields.filter(isComputedField)
+  const object = ts.objectType()
+  for (const field of computedFields) {
+    object.add(ts.property(field.name, ts.array(ts.stringLiteral).setDocComment(ts.docComment(`needs: ${(field.needs ?? []).join(', ')}`))))
+  }
+  return object
+}
+
+export function computedFieldRuntimeMetadata(model: DMMF.Model) {
+  return model.fields.filter(isComputedField).map((field) => ({
+    name: field.name,
+    type: field.type,
+    needs: field.needs ?? [],
+    expression: field.expression ?? '',
+    isList: field.isList,
+    isRequired: true,
+  }))
+}
+
+function buildComputedFieldComment(field: ComputedField, dmmf: DMMFHelper) {
+  const parts = [`Computed by Prisma from expression: ${field.expression ?? ''}`]
+  const dependencies = field.needs ?? []
+  if (dependencies.length > 0) {
+    parts.push(`Depends on: ${dependencies.join(', ')}`)
+  }
+  if (dmmf.isComposite(field.type)) {
+    parts.push('Composite computed values are returned by value.')
+  }
+  return parts.join('\n')
+}
diff --git a/packages/client-generator-ts/src/TSClient/Output.ts b/packages/client-generator-ts/src/TSClient/Output.ts
index 50a24ac2ad..7ac822465a 100644
--- a/packages/client-generator-ts/src/TSClient/Output.ts
+++ b/packages/client-generator-ts/src/TSClient/Output.ts
@@ -3,6 +3,7 @@ import { hasOwnProperty } from '@prisma/internals'
 import * as ts from '@prisma/ts-builders'
 
 import type { DMMFHelper } from '../dmmf'
+import { buildComputedFieldOutputProperty, isComputedField } from './ComputedFields'
 import { getPayloadName } from '../utils'
 import { GraphQLScalarToJSTypeTable } from '../utils/common'
 
 export function buildModelOutputProperty(field: DMMF.Field, dmmf: DMMFHelper) {
+  if (isComputedField(field)) {
+    return buildComputedFieldOutputProperty(field, dmmf)
+  }
+
   let fieldTypeName = hasOwnProperty(GraphQLScalarToJSTypeTable, field.type)
     ? GraphQLScalarToJSTypeTable[field.type]
     : field.type
diff --git a/packages/client-generator-ts/src/TSClient/Payload.ts b/packages/client-generator-ts/src/TSClient/Payload.ts
index 6a5c0e4bc0..cc6fb93d1d 100644
--- a/packages/client-generator-ts/src/TSClient/Payload.ts
+++ b/packages/client-generator-ts/src/TSClient/Payload.ts
@@ -5,6 +5,7 @@ import * as ts from '@prisma/ts-builders'
 import { extArgsParam, getPayloadName } from '../utils'
 import { GenerateContext } from './GenerateContext'
 import { buildModelOutputProperty } from './Output'
+import { buildComputedFieldPayloadType, computedFieldRuntimeMetadata, isComputedField } from './ComputedFields'
 
 export function buildModelPayload(model: DMMF.Model, context: GenerateContext) {
   const isComposite = context.dmmf.isComposite(model.name)
@@ -14,14 +15,22 @@ export function buildModelPayload(model: DMMF.Model, context: GenerateContext) {
   const scalars = ts.objectType()
   const composites = ts.objectType()
+  const computed = buildComputedFieldPayloadType(model, context.dmmf)
 
   for (const field of model.fields) {
+    if (isComputedField(field)) {
+      scalars.add(buildModelOutputProperty(field, context.dmmf))
+      continue
+    }
     if (field.kind === 'object') {
       if (context.dmmf.isComposite(field.type)) {
         composites.add(buildModelOutputProperty(field, context.dmmf))
       } else {
@@ -38,6 +47,7 @@ export function buildModelPayload(model: DMMF.Model, context: GenerateContext) {
         .namedType('runtime.Types.Extensions.GetPayloadResult')
         .addGenericArgument(scalars)
         .addGenericArgument(ts.namedType('ExtArgs').subKey('result').subKey(uncapitalize(model.name)))
+        .addGenericArgument(computed)
 
   const payloadTypeDeclaration = ts.typeDeclaration(
     getPayloadName(model.name, false),
@@ -47,6 +57,7 @@ export function buildModelPayload(model: DMMF.Model, context: GenerateContext) {
       .add(ts.property('objects', objects))
       .add(ts.property('scalars', scalarsType))
       .add(ts.property('composites', composites)),
+      .add(ts.property('computedFields', JSON.stringify(computedFieldRuntimeMetadata(model)) as any)),
   )
 
   if (!isComposite) {
diff --git a/packages/client/src/runtime/core/jsonProtocol/serializeJsonQuery.ts b/packages/client/src/runtime/core/jsonProtocol/serializeJsonQuery.ts
index 95c40f5ee2..6f516063a4 100644
--- a/packages/client/src/runtime/core/jsonProtocol/serializeJsonQuery.ts
+++ b/packages/client/src/runtime/core/jsonProtocol/serializeJsonQuery.ts
@@ -134,6 +134,11 @@ function createImplicitSelection(
     selectionSet.$scalars = true
   }
 
+  if (context.modelName && context.hasComputedFields()) {
+    selectionSet.$computed = context.getComputedFieldNames()
+  }
+
   if (include) {
     addIncludedRelations(selectionSet, include, context)
   }
@@ -245,6 +250,10 @@ function createExplicitSelection(select: Selection, context: SerializeContext) {
     if (computedFields?.[key] && !field) {
       continue
     }
+    if (context.isGeneratedComputedField(key)) {
+      selectionSet[key] = { $computed: true }
+      continue
+    }
     if (value === false || value === undefined || isSkip(value)) {
       selectionSet[key] = false
       continue
@@ -580,6 +589,31 @@ class SerializeContext {
     return this.params.globalOmit?.[this.params.modelName ?? ''] ?? {}
   }
 
+  get modelName() {
+    return this.params.modelName
+  }
+
+  hasComputedFields() {
+    return this.getComputedFieldNames().length > 0
+  }
+
+  getComputedFieldNames() {
+    if (!this.params.modelName) {
+      return []
+    }
+    return (
+      this.params.runtimeDataModel.computedFields?.[this.params.modelName]?.map((field) => field.name) ?? []
+    )
+  }
+
+  isGeneratedComputedField(name: string) {
+    if (!this.params.modelName) {
+      return false
+    }
+    return Boolean(
+      this.params.runtimeDataModel.computedFields?.[this.params.modelName]?.some((field) => field.name === name)
+    )
+  }
+
  getComputedFields() {
    if (!this.params.modelName) {
      return undefined
diff --git a/packages/client/src/runtime/core/extensions/generatedComputedFields.ts b/packages/client/src/runtime/core/extensions/generatedComputedFields.ts
new file mode 100644
index 0000000000..fc17c03a8f
--- /dev/null
+++ b/packages/client/src/runtime/core/extensions/generatedComputedFields.ts
@@ -0,0 +1,224 @@
+import type { RuntimeDataModel } from '@prisma/client-common'
+
+import type { JsonSelectionSet } from '../engines'
+import type { JsArgs, Selection } from '../types/exported/JsApi'
+
+export type GeneratedComputedField = {
+  name: string
+  type: string
+  expression: string
+  needs: string[]
+  isList: boolean
+  isRequired: boolean
+}
+
+export type GeneratedComputedFieldMap = Record<string, GeneratedComputedField[]>
+
+export function getGeneratedComputedFields(runtimeDataModel: RuntimeDataModel, modelName: string) {
+  return runtimeDataModel.computedFields?.[modelName] ?? []
+}
+
+export function hasGeneratedComputedFields(runtimeDataModel: RuntimeDataModel, modelName: string) {
+  return getGeneratedComputedFields(runtimeDataModel, modelName).length > 0
+}
+
+export function getGeneratedComputedFieldNames(runtimeDataModel: RuntimeDataModel, modelName: string) {
+  return getGeneratedComputedFields(runtimeDataModel, modelName).map((field) => field.name)
+}
+
+export function getGeneratedComputedField(
+  runtimeDataModel: RuntimeDataModel,
+  modelName: string,
+  fieldName: string
+) {
+  return getGeneratedComputedFields(runtimeDataModel, modelName).find((field) => field.name === fieldName)
+}
+
+export function addGeneratedComputedDependencies({
+  runtimeDataModel,
+  modelName,
+  selection,
+}: {
+  runtimeDataModel: RuntimeDataModel
+  modelName: string
+  selection: Selection
+}) {
+  const fields = getGeneratedComputedFields(runtimeDataModel, modelName)
+  if (fields.length === 0) {
+    return selection
+  }
+
+  const nextSelection = { ...selection }
+  for (const field of fields) {
+    if (!selection[field.name]) {
+      continue
+    }
+    for (const dependency of field.needs) {
+      nextSelection[dependency] = true
+    }
+  }
+  return nextSelection
+}
+
+export function removeGeneratedComputedDependencies({
+  result,
+  runtimeDataModel,
+  modelName,
+  args,
+}: {
+  result: unknown
+  runtimeDataModel: RuntimeDataModel
+  modelName: string
+  args: JsArgs
+}) {
+  if (!result || typeof result !== 'object') {
+    return result
+  }
+  const fields = getGeneratedComputedFields(runtimeDataModel, modelName)
+  if (fields.length === 0) {
+    return result
+  }
+  const selectedComputedFields = new Set(
+    Object.entries(args.select ?? {})
+      .filter(([, value]) => value)
+      .map(([key]) => key)
+  )
+  const dependencyNames = new Set<string>()
+  for (const field of fields) {
+    if (!selectedComputedFields.has(field.name)) {
+      continue
+    }
+    for (const dependency of field.needs) {
+      if (!selectedComputedFields.has(dependency)) {
+        dependencyNames.add(dependency)
+      }
+    }
+  }
+  if (dependencyNames.size === 0) {
+    return result
+  }
+  return stripDependencies(result, dependencyNames)
+}
+
+function stripDependencies(value: unknown, dependencies: Set<string>): unknown {
+  if (Array.isArray(value)) {
+    return value.map((item) => stripDependencies(item, dependencies))
+  }
+  if (!value || typeof value !== 'object') {
+    return value
+  }
+  const copy: Record<string, unknown> = { ...(value as Record<string, unknown>) }
+  for (const dependency of dependencies) {
+    delete copy[dependency]
+  }
+  return copy
+}
+
+export function addImplicitGeneratedComputedSelection({
+  runtimeDataModel,
+  modelName,
+  selectionSet,
+}: {
+  runtimeDataModel: RuntimeDataModel
+  modelName: string
+  selectionSet: JsonSelectionSet
+}) {
+  const computedFields = getGeneratedComputedFields(runtimeDataModel, modelName)
+  if (computedFields.length === 0) {
+    return selectionSet
+  }
+  selectionSet.$computed = computedFields.map((field) => field.name)
+  return selectionSet
+}
+
+export function serializeGeneratedComputedFieldSelection({
+  runtimeDataModel,
+  modelName,
+  fieldName,
+}: {
+  runtimeDataModel: RuntimeDataModel
+  modelName: string
+  fieldName: string
+}) {
+  const field = getGeneratedComputedField(runtimeDataModel, modelName, fieldName)
+  if (!field) {
+    return undefined
+  }
+  return {
+    $computed: true,
+    expression: field.expression,
+    needs: field.needs,
+    isRequired: true,
+  }
+}
+
+export function generatedComputedFieldsDebugInfo(runtimeDataModel: RuntimeDataModel, modelName: string) {
+  return getGeneratedComputedFields(runtimeDataModel, modelName).map((field) => ({
+    name: field.name,
+    dependencies: field.needs.join(','),
+    type: field.type,
+    nullable: false,
+  }))
+}
+
+export function computedFieldsForTelemetry(runtimeDataModel: RuntimeDataModel) {
+  const fields = runtimeDataModel.computedFields ?? {}
+  return Object.entries(fields).flatMap(([modelName, modelFields]) =>
+    modelFields.map((field) => ({
+      modelName,
+      fieldName: field.name,
+      dependencyCount: field.needs.length,
+      expressionLength: field.expression.length,
+      type: field.type,
+      isList: field.isList,
+      isRequired: true,
+    }))
+  )
+}
+
+export function assertGeneratedComputedFieldIsSelectable({
+  runtimeDataModel,
+  modelName,
+  fieldName,
+}: {
+  runtimeDataModel: RuntimeDataModel
+  modelName: string
+  fieldName: string
+}) {
+  const field = getGeneratedComputedField(runtimeDataModel, modelName, fieldName)
+  if (!field) {
+    throw new Error(`Unknown generated computed field ${modelName}.${fieldName}`)
+  }
+  return field
+}
+
+export function needsForGeneratedComputedField({
+  runtimeDataModel,
+  modelName,
+  fieldName,
+}: {
+  runtimeDataModel: RuntimeDataModel
+  modelName: string
+  fieldName: string
+}) {
+  return assertGeneratedComputedFieldIsSelectable({ runtimeDataModel, modelName, fieldName }).needs
+}
+
+export function generatedComputedFieldPayloadShape({
+  runtimeDataModel,
+  modelName,
+}: {
+  runtimeDataModel: RuntimeDataModel
+  modelName: string
+}) {
+  return getGeneratedComputedFields(runtimeDataModel, modelName).reduce<Record<string, unknown>>(
+    (shape, field) => {
+      shape[field.name] = {
+        type: field.type,
+        list: field.isList,
+        required: true,
+      }
+      return shape
+    },
+    {}
+  )
+}
diff --git a/packages/client/src/runtime/core/jsonProtocol/serializeJsonQuery.test.ts b/packages/client/src/runtime/core/jsonProtocol/serializeJsonQuery.test.ts
index 262bcabf21..6fe6f7ae01 100644
--- a/packages/client/src/runtime/core/jsonProtocol/serializeJsonQuery.test.ts
+++ b/packages/client/src/runtime/core/jsonProtocol/serializeJsonQuery.test.ts
@@ -1462,6 +1462,189 @@ test('include on scalar field', () => {
   })
 })
+
+test('serializes implicit generated computed fields', () => {
+  expect(
+    serialize({
+      modelName: 'User',
+      action: 'findMany',
+      runtimeDataModel: {
+        models: {
+          User: {
+            dbName: null,
+            fields: [
+              { name: 'id', kind: 'scalar', type: 'Int', dbName: null },
+              { name: 'firstName', kind: 'scalar', type: 'String', dbName: null },
+              { name: 'lastName', kind: 'scalar', type: 'String', dbName: null },
+            ],
+          },
+        },
+        enums: {},
+        types: {},
+        computedFields: {
+          User: [
+            {
+              name: 'fullName',
+              type: 'String',
+              expression: "concat(firstName, ' ', lastName)",
+              needs: ['firstName', 'lastName'],
+              isList: false,
+              isRequired: true,
+            },
+          ],
+        },
+      },
+    })
+  ).toMatchInlineSnapshot(`
+    "{
+      "modelName": "User",
+      "action": "findMany",
+      "query": {
+        "arguments": {},
+        "selection": {
+          "$composites": true,
+          "$scalars": true,
+          "$computed": [
+            "fullName"
+          ]
+        }
+      }
+    }"
+  `)
+})
+
+test('serializes explicit generated computed field selection', () => {
+  expect(
+    serialize({
+      modelName: 'User',
+      action: 'findFirst',
+      args: {
+        select: {
+          id: true,
+          fullName: true,
+        },
+      },
+      runtimeDataModel: {
+        models: {
+          User: {
+            dbName: null,
+            fields: [
+              { name: 'id', kind: 'scalar', type: 'Int', dbName: null },
+              { name: 'firstName', kind: 'scalar', type: 'String', dbName: null },
+              { name: 'lastName', kind: 'scalar', type: 'String', dbName: null },
+            ],
+          },
+        },
+        enums: {},
+        types: {},
+        computedFields: {
+          User: [
+            {
+              name: 'fullName',
+              type: 'String',
+              expression: "concat(firstName, ' ', lastName)",
+              needs: ['firstName', 'lastName'],
+              isList: false,
+              isRequired: true,
+            },
+          ],
+        },
+      },
+    })
+  ).toMatchInlineSnapshot(`
+    "{
+      "modelName": "User",
+      "action": "findUnique",
+      "query": {
+        "arguments": {},
+        "selection": {
+          "id": true,
+          "fullName": {
+            "$computed": true
+          }
+        }
+      }
+    }"
+  `)
+})
+
+test('does not require selecting dependencies when selecting generated computed fields', () => {
+  const query = serialize({
+    modelName: 'User',
+    action: 'findFirst',
+    args: {
+      select: {
+        fullName: true,
+      },
+    },
+    runtimeDataModel: {
+      models: {
+        User: {
+          dbName: null,
+          fields: [
+            { name: 'id', kind: 'scalar', type: 'Int', dbName: null },
+            { name: 'firstName', kind: 'scalar', type: 'String', dbName: null },
+            { name: 'lastName', kind: 'scalar', type: 'String', dbName: null },
+          ],
+        },
+      },
+      enums: {},
+      types: {},
+      computedFields: {
+        User: [
+          {
+            name: 'fullName',
+            type: 'String',
+            expression: "concat(firstName, ' ', lastName)",
+            needs: ['firstName', 'lastName'],
+            isList: false,
+            isRequired: true,
+          },
+        ],
+      },
+    },
+  })
+
+  expect(query.query.selection).toEqual({
+    fullName: {
+      $computed: true,
+    },
+  })
+})
+
+test('serializes generated computed fields for nested relation selection', () => {
+  const query = serialize({
+    modelName: 'Post',
+    action: 'findMany',
+    args: {
+      select: {
+        id: true,
+        author: {
+          select: {
+            fullName: true,
+          },
+        },
+      },
+    },
+    runtimeDataModel: {
+      models: {
+        Post: {
+          dbName: null,
+          fields: [
+            { name: 'id', kind: 'scalar', type: 'Int', dbName: null },
+            { name: 'author', kind: 'object', type: 'User', relationName: 'PostToUser', dbName: null },
+          ],
+        },
+        User: {
+          dbName: null,
+          fields: [
+            { name: 'id', kind: 'scalar', type: 'Int', dbName: null },
+            { name: 'firstName', kind: 'scalar', type: 'String', dbName: null },
+            { name: 'lastName', kind: 'scalar', type: 'String', dbName: null },
+          ],
+        },
+      },
+      enums: {},
+      types: {},
+      computedFields: {
+        User: [
+          {
+            name: 'fullName',
+            type: 'String',
+            expression: "concat(firstName, ' ', lastName)",
+            needs: ['firstName', 'lastName'],
+            isList: false,
+            isRequired: true,
+          },
+        ],
+      },
+    },
+  })
+
+  expect(query.query.selection.author.selection.fullName).toEqual({ $computed: true })
+})
diff --git a/packages/client-engine-runtime/src/json-protocol.ts b/packages/client-engine-runtime/src/json-protocol.ts
index 4a674ab041..f3b1bdce9d 100644
--- a/packages/client-engine-runtime/src/json-protocol.ts
+++ b/packages/client-engine-runtime/src/json-protocol.ts
@@ -18,6 +18,7 @@ export type JsonInputTaggedValue =
 export type JsonOutputTaggedValue =
   | DateTaggedValue
   | DecimalTaggedValue
+  | ComputedTaggedValue
   | BytesTaggedValue
   | BigIntTaggedValue
   | JsonTaggedValue
@@ -25,6 +26,11 @@ export type JsonOutputTaggedValue =
 
 export type JsOutputValue =
   | null
+  | {
+      $computed: true
+      value: JsOutputValue
+    }
   | string
   | number
   | boolean
@@ -34,6 +40,8 @@ export type JsOutputValue =
   | JsOutputValue[]
   | { [key: string]: JsOutputValue }
 
+export type ComputedTaggedValue = { $type: 'Computed'; value: JsOutputValue }
+
 export function normalizeJsonProtocolValues(result: unknown): unknown {
   if (result === null) {
     return result
@@ -75,6 +83,8 @@ function normalizeTaggedValue({
   switch ($type) {
     case 'BigInt':
       return { $type, value: value.toString() }
+    case 'Computed':
+      return normalizeJsonProtocolValues(value)
     case 'Bytes':
       return { $type, value }
     case 'DateTime':
diff --git a/packages/client/tests/functional/computed-fields/_matrix.ts b/packages/client/tests/functional/computed-fields/_matrix.ts
new file mode 100644
index 0000000000..da81fa9105
--- /dev/null
+++ b/packages/client/tests/functional/computed-fields/_matrix.ts
@@ -0,0 +1,36 @@
+import { Providers } from '../../_utils/providers'
+import testMatrix from '../_utils/testMatrix'
+
+export default testMatrix.setupTestSuiteMatrix(() => [
+  [
+    {
+      provider: Providers.POSTGRESQL,
+    },
+  ],
+])
diff --git a/packages/client/tests/functional/computed-fields/prisma/_schema.ts b/packages/client/tests/functional/computed-fields/prisma/_schema.ts
new file mode 100644
index 0000000000..9566082794
--- /dev/null
+++ b/packages/client/tests/functional/computed-fields/prisma/_schema.ts
@@ -0,0 +1,94 @@
+import type { PrismaSchema } from '../../_utils/types'
+
+export default function ({ provider }: { provider: string }): PrismaSchema {
+  return /* Prisma */ `
+    generator client {
+      provider = "prisma-client-js"
+      previewFeatures = ["computedFields"]
+    }
+
+    datasource db {
+      provider = "${provider}"
+      url      = env("DATABASE_URI_${provider}")
+    }
+
+    model User {
+      id        Int     @id @default(autoincrement())
+      email     String  @unique
+      firstName String?
+      lastName  String?
+
+      fullName  String  @computed(expr: "concat(firstName, ' ', lastName)", needs: [firstName, lastName])
+      initials  String  @computed(expr: "upper(substr(firstName, 1, 1) || substr(lastName, 1, 1))", needs: [firstName, lastName])
+
+      posts     Post[]
+    }
+
+    model Post {
+      id        Int    @id @default(autoincrement())
+      title     String
+      subtitle  String?
+      authorId  Int
+      author    User   @relation(fields: [authorId], references: [id])
+
+      label     String @computed(expr: "concat(title, ': ', subtitle)", needs: [title, subtitle])
+    }
+  `
+}
diff --git a/packages/client/tests/functional/computed-fields/tests.ts b/packages/client/tests/functional/computed-fields/tests.ts
new file mode 100644
index 0000000000..99602c8a7e
--- /dev/null
+++ b/packages/client/tests/functional/computed-fields/tests.ts
@@ -0,0 +1,236 @@
+import { expectTypeOf } from 'expect-type'
+
+import testMatrix from './_matrix'
+import type { Post, PrismaClient, User } from './generated/prisma/client'
+
+declare let prisma: PrismaClient
+
+testMatrix.setupTestSuite(() => {
+  beforeEach(async () => {
+    await prisma.post.deleteMany()
+    await prisma.user.deleteMany()
+    await prisma.user.create({
+      data: {
+        email: 'ada@example.com',
+        firstName: 'Ada',
+        lastName: 'Lovelace',
+        posts: {
+          create: {
+            title: 'Notes',
+            subtitle: 'Analytical Engine',
+          },
+        },
+      },
+    })
+    await prisma.user.create({
+      data: {
+        email: 'nulls@example.com',
+        firstName: null,
+        lastName: null,
+      },
+    })
+  })
+
+  test('selects generated computed field', async () => {
+    const user = await prisma.user.findUniqueOrThrow({
+      where: {
+        email: 'ada@example.com',
+      },
+      select: {
+        id: true,
+        fullName: true,
+      },
+    })
+
+    expect(user).toEqual({
+      id: expect.any(Number),
+      fullName: 'Ada Lovelace',
+    })
+    expectTypeOf(user.fullName).toEqualTypeOf<string>()
+  })
+
+  test('computed fields are included by default', async () => {
+    const user = await prisma.user.findUniqueOrThrow({
+      where: {
+        email: 'ada@example.com',
+      },
+    })
+
+    expect(user.fullName).toBe('Ada Lovelace')
+    expect(user.initials).toBe('AL')
+    expectTypeOf(user.fullName).toEqualTypeOf<string>()
+    expectTypeOf(user.initials).toEqualTypeOf<string>()
+  })
+
+  test('computed fields work for nested include', async () => {
+    const user = await prisma.user.findUniqueOrThrow({
+      where: {
+        email: 'ada@example.com',
+      },
+      include: {
+        posts: true,
+      },
+    })
+
+    expect(user.posts[0].label).toBe('Notes: Analytical Engine')
+    expectTypeOf(user.posts[0].label).toEqualTypeOf<string>()
+  })
+
+  test('null dependencies still return string type', async () => {
+    const user = await prisma.user.findUniqueOrThrow({
+      where: {
+        email: 'nulls@example.com',
+      },
+      select: {
+        fullName: true,
+      },
+    })
+
+    expect(user.fullName).toBeNull()
+    expectTypeOf(user.fullName).toEqualTypeOf<string>()
+  })
+
+  test('computed field can be omitted', async () => {
+    const user = await prisma.user.findUniqueOrThrow({
+      where: {
+        email: 'ada@example.com',
+      },
+      omit: {
+        fullName: true,
+      },
+    })
+
+    expect(user).not.toHaveProperty('fullName')
+    expect(user.email).toBe('ada@example.com')
+  })
+
+  test('create returns computed fields', async () => {
+    const user = await prisma.user.create({
+      data: {
+        email: 'grace@example.com',
+        firstName: 'Grace',
+        lastName: 'Hopper',
+      },
+    })
+
+    expect(user.fullName).toBe('Grace Hopper')
+    expectTypeOf(user).toMatchTypeOf<User>()
+  })
+
+  test('post computed label supports nullable dependency', async () => {
+    const post = await prisma.post.create({
+      data: {
+        title: 'Untitled',
+        subtitle: null,
+        author: {
+          connect: {
+            email: 'ada@example.com',
+          },
+        },
+      },
+    })
+
+    expect(post.label).toBeNull()
+    expectTypeOf(post).toMatchTypeOf<Post>()
+  })
+})
```

## Intended Flaws

### Flaw 1: Computed Fields Are Generated As Required Even When Runtime Can Return Null

- `type`: `type_runtime_contract`
- `location`: `packages/dmmf/src/computed-fields.ts:15-26`, `packages/dmmf/src/computed-fields.ts:39-47`, `packages/client-common/src/runtimeDataModel.ts:91-100`, `packages/client-generator-ts/src/TSClient/ComputedFields.ts:15-39`, `packages/client/tests/functional/computed-fields/tests.ts:63-78`, `packages/client/tests/functional/computed-fields/tests.ts:107-122`
- `learner_prompt`: What should the generated TypeScript type be when a computed expression depends on nullable fields?

Expected answer:

- `identify`: The PR forces computed fields to `isRequired: true` in the DMMF conversion, parser, runtime datamodel, and generated output property. `buildComputedFieldOutputProperty` never unions `null` for a non-list field, even though the test itself expects `user.fullName` and `post.label` to be `null` when dependencies are nullable. The generated type says `string`, while runtime can produce `null`.
- `impact`: Users will write code that treats computed fields as always present strings and then hit production `null` values from the engine. This is especially dangerous because generated client types are the contract people trust most. It also breaks type-level guarantees for nested results, creates false confidence in schema migrations, and makes downstream generated API schemas lie.
- `fix_direction`: Carry computed-field nullability explicitly through DMMF, runtime data model, payload generation, and tests. Infer nullability from expression semantics where possible, otherwise require the schema author to declare it. Generate `string | null` when any dependency or expression can be null, and add tests that assert the type is nullable instead of blessing a mismatch.

Hints:

1. Look for places that hard-code `isRequired: true`.
2. The test that expects `toBeNull()` also expects the type to be `string`.
3. Generated client types are a product contract, not just build output.

### Flaw 2: The Client Sends New Computed-Field Protocol Without Version Or Capability Gating

- `type`: `protocol_compatibility`
- `location`: `packages/client/src/runtime/core/jsonProtocol/serializeJsonQuery.ts:134-139`, `packages/client/src/runtime/core/jsonProtocol/serializeJsonQuery.ts:250-254`, `packages/client/src/runtime/core/jsonProtocol/serializeJsonQuery.test.ts:1462-1651`, `packages/client-engine-runtime/src/json-protocol.ts:18-44`, `packages/client/tests/functional/computed-fields/_matrix.ts:1-10`, `packages/client/tests/functional/computed-fields/tests.ts:34-61`
- `learner_prompt`: What happens if this generated client talks to an older query engine, Data Proxy, Accelerate path, or adapter runtime?

Expected answer:

- `identify`: The serializer unconditionally adds `$computed` to implicit selections and sends `{ $computed: true }` for explicit computed fields. There is no protocol version bump, engine capability check, preview-feature handshake, fallback path, or adapter coverage. The test matrix only covers a happy-path PostgreSQL engine that understands the new shape.
- `impact`: Generated clients can break during rolling deploys or mixed-version environments. Old engines, Data Proxy, Accelerate, or driver-adapter runtimes may reject unknown `$computed` selection keys or return raw tagged values the client does not understand. This turns a type-generation feature into runtime failures for users whose client and engine versions are temporarily out of sync.
- `fix_direction`: Treat the engine protocol as a versioned boundary. Add a protocol capability flag for computed selections, gate serialization on that capability and preview feature, and provide a client-side fallback using the existing result-extension dependency selection model where possible. Expand tests to old-engine rejection, Data Proxy/Accelerate/adapter paths, and mixed-version snapshots before making the generated client emit the new protocol by default.

Hints:

1. Search for a protocol version, capability flag, or engine feature check in the diff.
2. The real client extension path computes fields after the engine returns data.
3. A single PostgreSQL functional test does not prove compatibility across Prisma's engine surfaces.

## Final Expert Debrief

### Correctness Verdict

For flaw 1, a correct answer must identify the type/runtime nullability mismatch. Answers that only mention "computed fields can be null" are incomplete unless they connect it to generated required output types.

For flaw 2, a correct answer must identify that the generated client now sends a new JSON protocol shape without versioning or capability negotiation. Answers that only say "add more tests" are incomplete unless they explain the mixed-version failure mode.

### Product-Level Change

The PR tries to promote computed fields from client extensions into the Prisma schema and generated client. That is a powerful product direction because generated types would make computed values feel first-class.

### Changed Contracts

- Schema contract: a new `@computed` field attribute appears in the datamodel.
- DMMF contract: computed fields become part of model metadata.
- Generated type contract: computed fields appear in payloads and select output.
- Runtime protocol contract: the client sends computed selections to the query engine.
- Rollout contract: generated clients now assume engine support for a new selection shape.

### Failure Modes

A user adds `fullName String @computed(...)` over nullable `firstName` and `lastName`. TypeScript says `fullName` is a string. Production data has a user with both names null. The API server calls `user.fullName.toUpperCase()` and crashes.

A company deploys a new generated client before all query-engine binaries or Data Proxy workers have rolled. The client sends `$computed`; the older engine rejects the request as an unknown selection field. Every query selecting that computed field fails during rollout.

### Reviewer Thought Process

A strong reviewer asks whether a feature is client-only sugar or a cross-boundary protocol change. Existing result extensions are client-side and already have dependency-selection/masking machinery. This PR moves computation across the engine boundary, so the reviewer looks for versioning, fallback, and compatibility tests.

Then the reviewer checks generated types against runtime values. Anything generated by Prisma Client becomes something application code will trust. If runtime can produce `null`, the type cannot claim it is always a string.

### Better Implementation Direction

- Preserve the current client-extension approach as the fallback path.
- Add computed-field nullability metadata and generated nullable output where required.
- Gate engine-side computed selection behind an explicit protocol capability.
- Version the JSON protocol change and test mixed-version behavior.
- Expand provider/runtime coverage beyond one PostgreSQL path.
- Add type tests that fail when runtime-nullable computed fields are exposed as required.

## Why This Case Exists

This case teaches that generated code is a public contract. The hard part is not adding a field to the generated client; it is keeping types, runtime values, engine protocol, and rollout behavior aligned.
