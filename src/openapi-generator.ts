import {
  ReferenceObject,
  SchemaObject,
  ParameterObject,
  RequestBodyObject,
  PathItemObject,
  PathObject,
  OpenAPIObject,
  InfoObject,
  ServerObject,
  SecurityRequirementObject,
  TagObject,
  ExternalDocumentationObject,
  ComponentsObject,
} from 'openapi3-ts';
import {
  ZodArray,
  ZodBoolean,
  ZodEnum,
  ZodIntersection,
  ZodLiteral,
  ZodNativeEnum,
  ZodNull,
  ZodNullable,
  ZodNumber,
  ZodObject,
  ZodOptional,
  ZodRawShape,
  ZodSchema,
  ZodString,
  ZodType,
  ZodUnion,
} from 'zod';
import { flatMap, isNil, isUndefined, mapValues, omit, omitBy } from 'lodash';
import {
  ZodOpenAPIMetadata,
  ZodOpenAPIParameterMetadata,
} from './zod-extensions';
import { OpenAPIDefinitions, RouteConfig } from './openapi-registry';

// See https://github.com/colinhacks/zod/blob/9eb7eb136f3e702e86f030e6984ef20d4d8521b6/src/types.ts#L1370
type UnknownKeysParam = 'passthrough' | 'strict' | 'strip';

// This is essentially OpenAPIObject without the components and paths keys.
// Omit does not work, since OpenAPIObject extends ISpecificationExtension
// and is inferred as { [key: number]: any; [key: string]: any }
interface OpenAPIObjectConfig {
  openapi: string;
  info: InfoObject;
  servers?: ServerObject[];
  security?: SecurityRequirementObject[];
  tags?: TagObject[];
  externalDocs?: ExternalDocumentationObject;
}

export class OpenAPIGenerator {
  private schemaRefs: Record<string, SchemaObject> = {};
  private paramRefs: Record<string, ParameterObject> = {};
  private pathRefs: Record<string, Record<string, PathObject>> = {};

  constructor(
    private definitions: OpenAPIDefinitions[],
    private config?: OpenAPIObjectConfig
  ) {}

  // TODO: generateRoot maybe?
  generateDocs(): OpenAPIObject {
    // TODO: Maybe pass as parameter
    if (!this.config) {
      throw new Error(
        'No config was provided when creating the OpenAPIGenerator'
      );
    }

    this.definitions.forEach((definition) => this.generateSingle(definition));

    return {
      ...this.config,
      components: {
        schemas: this.schemaRefs,
        parameters: this.paramRefs,
      },
      paths: this.pathRefs,
    };
  }

  generateComponents(): ComponentsObject {
    this.definitions.forEach((definition) => this.generateSingle(definition));

    return {
      components: {
        schemas: this.schemaRefs,
        parameters: this.paramRefs,
      },
    };
  }

  private generateSingle(
    definition: OpenAPIDefinitions
  ): SchemaObject | ParameterObject | ReferenceObject {
    if (definition.type === 'parameter') {
      return this.generateParameterDefinition(definition.schema);
    }

    if (definition.type === 'schema') {
      return this.generateSchemaDefinition(definition.schema);
    }

    if (definition.type === 'route') {
      return this.generateSingleRoute(definition.route);
    }

    throw new Error('Invalid definition type');
  }

  private generateParameterDefinition(
    zodSchema: ZodSchema<any>
  ): ParameterObject | ReferenceObject {
    const metadata = this.getMetadata(
      zodSchema
    ) as Partial<ZodOpenAPIParameterMetadata>;

    const result = this.generateParameter(zodSchema);

    if (metadata?.refId) {
      this.paramRefs[metadata.refId] = result;
    }

    return result;
  }

  private generateInlineParameter(
    zodSchema: ZodSchema<any>
  ): ParameterObject | ReferenceObject {
    const metadata = this.getMetadata(
      zodSchema
    ) as Partial<ZodOpenAPIParameterMetadata>;
    const existingRef = metadata?.refId
      ? this.paramRefs[metadata.refId]
      : undefined;

    if (existingRef) {
      return {
        $ref: `#/components/parameters/${metadata.refId}`,
      };
    }

    return this.generateParameter(zodSchema);
  }

  private generateParameter(zodSchema: ZodSchema<any>): ParameterObject {
    const metadata = this.getMetadata(
      zodSchema
    ) as Partial<ZodOpenAPIParameterMetadata>;

    const paramName = metadata?.name;
    const paramLocation = metadata?.in;

    if (!paramName) {
      throw new Error(
        'Missing parameter name, please specify `name` and other OpenAPI props using `ZodSchema.openapi`'
      );
    }

    // TODO: Might add custom errors.
    if (!paramLocation) {
      throw new Error(
        `Missing parameter location for parameter ${paramName}, please specify \`in\` and other OpenAPI props using \`ZodSchema.openapi\``
      );
    }

    const required = !zodSchema.isOptional() && !zodSchema.isNullable();

    const schema = this.generatePlainSchema(zodSchema);

    return {
      in: paramLocation,
      name: paramName,
      schema,
      required,
      ...(metadata ? this.buildMetadata(metadata) : {}),
    };
  }

  /**
   * Generates an OpenAPI SchemaObject or a ReferenceObject without applying
   * the metadata provided. i.e it generates a ref or a simple type
   */
  private generatePlainSchema(
    zodSchema: ZodSchema<any>
  ): SchemaObject | ReferenceObject {
    const innerSchema = this.unwrapOptional(zodSchema);
    const metadata = zodSchema._def.openapi
      ? zodSchema._def.openapi
      : innerSchema._def.openapi;

    const refId = metadata?.refId;

    if (refId && this.schemaRefs[refId]) {
      return {
        $ref: `#/components/schemas/${refId}`,
      };
    }

    return this.toOpenAPISchema(
      innerSchema,
      zodSchema.isNullable(),
      !!metadata?.type
    );
  }

  /**
   * Generates an OpenAPI SchemaObject or a ReferenceObject with all the provided metadata applied
   */
  private generateSimpleSchema(
    zodSchema: ZodSchema<any>
  ): SchemaObject | ReferenceObject {
    const innerSchema = this.unwrapOptional(zodSchema);
    const metadata = zodSchema._def.openapi
      ? zodSchema._def.openapi
      : innerSchema._def.openapi;

    const refId = metadata?.refId;

    if (refId && this.schemaRefs[refId]) {
      return {
        $ref: `#/components/schemas/${refId}`,
      };
    }

    const result = this.toOpenAPISchema(
      innerSchema,
      zodSchema.isNullable(),
      !!metadata?.type
    );

    return metadata ? this.applyMetadata(result, metadata) : result;
  }

  private generateInnerSchema(
    zodSchema: ZodSchema<any>,
    metadata?: ZodOpenAPIMetadata
  ): SchemaObject | ReferenceObject {
    const simpleSchema = this.generateSimpleSchema(zodSchema);

    if (simpleSchema.$ref) {
      return simpleSchema;
    }

    return metadata ? this.applyMetadata(simpleSchema, metadata) : simpleSchema;
  }

  private generateSchemaDefinition(zodSchema: ZodSchema<any>): SchemaObject {
    const metadata = this.getMetadata(zodSchema);
    const refId = metadata?.refId;

    const simpleSchema = this.generateSimpleSchema(zodSchema);

    const result = metadata
      ? this.applyMetadata(simpleSchema, metadata)
      : simpleSchema;

    if (refId) {
      this.schemaRefs[refId] = result;
    }

    return result;
  }

  private getBodyDoc(
    bodySchema: ZodType<unknown> | undefined
  ): RequestBodyObject | undefined {
    if (!bodySchema) {
      return;
    }

    const schema = this.generateInnerSchema(bodySchema);
    const metadata = this.getMetadata(bodySchema);

    return {
      description: metadata?.description,
      required: true,
      content: {
        // TODO: Maybe should be coming from metadata
        'application/json': {
          schema,
        },
      },
    };
  }

  private getParameters(
    request: RouteConfig['request'] | undefined
  ): (ParameterObject | ReferenceObject)[] {
    if (!request) {
      return [];
    }

    const parameters = request.parameters?.map((param) =>
      this.generateInlineParameter(param)
    );

    return parameters ?? [];
  }

  private generateSingleRoute(route: RouteConfig) {
    const responseSchema = this.generateInnerSchema(route.response);

    const routeDoc: PathItemObject = {
      [route.method]: {
        description: route.description,
        summary: route.summary,

        parameters: this.getParameters(route.request),

        requestBody: this.getBodyDoc(route.request?.body),

        responses: {
          [200]: {
            description: route.response._def.openapi?.description,
            content: {
              'application/json': {
                schema: responseSchema,
              },
            },
          },
          // TODO: errors
        },
      },
    };

    this.pathRefs[route.path] = {
      ...this.pathRefs[route.path],
      ...routeDoc,
    };

    return routeDoc;
  }

  private toOpenAPISchema(
    zodSchema: ZodSchema<any>,
    isNullable: boolean,
    hasOpenAPIType: boolean
  ): SchemaObject {
    if (zodSchema instanceof ZodNull) {
      return { type: 'null' };
    }

    if (zodSchema instanceof ZodString) {
      return {
        type: 'string',
        nullable: isNullable ? true : undefined,
      };
    }

    if (zodSchema instanceof ZodNumber) {
      return {
        type: 'number',
        minimum: zodSchema.minValue ?? undefined,
        maximum: zodSchema.maxValue ?? undefined,
        nullable: isNullable ? true : undefined,
      };
    }

    if (zodSchema instanceof ZodBoolean) {
      return {
        type: 'boolean',
        nullable: isNullable ? true : undefined,
      };
    }

    if (zodSchema instanceof ZodLiteral) {
      return {
        type: typeof zodSchema._def.value as SchemaObject['type'],
        nullable: isNullable ? true : undefined,
        enum: [zodSchema._def.value],
      };
    }

    if (zodSchema instanceof ZodEnum) {
      // ZodEnum only accepts strings
      return {
        type: 'string',
        nullable: isNullable ? true : undefined,
        enum: zodSchema._def.values,
      };
    }

    if (zodSchema instanceof ZodNativeEnum) {
      const enumValues = Object.values(zodSchema._def.values);

      // ZodNativeEnum can accepts number values for enum but in odd format
      // Not worth it for now so using plain string
      return {
        type: 'string',
        nullable: isNullable ? true : undefined,
        enum: enumValues,
      };
    }

    if (zodSchema instanceof ZodObject) {
      return this.toOpenAPIObjectSchema(zodSchema, isNullable);
    }

    if (zodSchema instanceof ZodArray) {
      const itemType = zodSchema._def.type as ZodSchema<any>;

      return {
        type: 'array',
        items: this.generateInnerSchema(itemType),

        minItems: zodSchema._def.minLength?.value,
        maxItems: zodSchema._def.maxLength?.value,
      };
    }

    if (zodSchema instanceof ZodUnion) {
      const options = this.flattenUnionTypes(zodSchema);

      return {
        anyOf: options.map((schema) => this.generateInnerSchema(schema)),
      };
    }

    if (zodSchema instanceof ZodIntersection) {
      const subtypes = this.flattenIntersectionTypes(zodSchema);

      return {
        allOf: subtypes.map((schema) => this.generateInnerSchema(schema)),
      };
    }

    if (hasOpenAPIType) {
      return {};
    }

    const refId = this.getMetadata(zodSchema)?.refId;
    const errorFor = refId ? ` for ${refId}` : '';

    throw new Error(
      `Unknown zod object type${errorFor}, please specify \`type\` and other OpenAPI props using \`ZodSchema.openapi\`. The current schema is: ` +
        JSON.stringify(zodSchema._def)
    );
  }

  private toOpenAPIObjectSchema(
    zodSchema: ZodObject<ZodRawShape>,
    isNullable: boolean
  ): SchemaObject {
    const propTypes = zodSchema._def.shape();
    const unknownKeysOption = zodSchema._unknownKeys as UnknownKeysParam;

    return {
      type: 'object',

      properties: mapValues(propTypes, (propSchema) =>
        this.generateInnerSchema(propSchema)
      ),

      required: Object.entries(propTypes)
        .filter(([_key, type]) => !type.isOptional())
        .map(([key, _type]) => key),

      additionalProperties: unknownKeysOption === 'passthrough' || undefined,

      nullable: isNullable ? true : undefined,
    };
  }

  private flattenUnionTypes(schema: ZodSchema<any>): ZodSchema<any>[] {
    if (!(schema instanceof ZodUnion)) {
      return [schema];
    }

    const options = schema._def.options as ZodSchema<any>[];

    return flatMap(options, (option) => this.flattenUnionTypes(option));
  }

  private flattenIntersectionTypes(schema: ZodSchema<any>): ZodSchema<any>[] {
    if (!(schema instanceof ZodIntersection)) {
      return [schema];
    }

    const leftSubTypes = this.flattenIntersectionTypes(schema._def.left);
    const rightSubTypes = this.flattenIntersectionTypes(schema._def.right);

    return [...leftSubTypes, ...rightSubTypes];
  }

  private unwrapOptional(schema: ZodSchema<any>): ZodSchema<any> {
    while (schema instanceof ZodOptional || schema instanceof ZodNullable) {
      schema = schema.unwrap();
    }

    return schema;
  }

  // The open api metadata can come in any format - ParameterObject/SchemaObject.
  // We leave it up to the user to define it and take care of it
  private buildMetadata(metadata: Partial<ZodOpenAPIMetadata>) {
    return omitBy(omit(metadata, 'name', 'refId'), isNil);
  }

  private getMetadata(zodSchema: ZodSchema<any>) {
    const innerSchema = this.unwrapOptional(zodSchema);
    const metadata = zodSchema._def.openapi
      ? zodSchema._def.openapi
      : innerSchema._def.openapi;

    return metadata;
  }

  private applyMetadata(
    initialData: SchemaObject | ParameterObject,
    metadata: Partial<ZodOpenAPIMetadata>
  ): SchemaObject | ReferenceObject {
    return omitBy(
      {
        ...initialData,
        ...this.buildMetadata(metadata),
      },
      isUndefined
    );
  }
}
