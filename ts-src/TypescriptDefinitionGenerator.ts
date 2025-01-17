import ts, { SyntaxKind } from 'typescript';
import { importClassAsync, JavaClass } from './.';
import fs from 'fs';
import path from 'path';

const sourceFile = ts.createSourceFile(
    'source.ts',
    '',
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.TS
);

export interface MethodDeclaration {
    returnType: string;
    parameters: string[];
    isStatic: boolean;
}

/**
 * A java class declaration converted to typescript
 */
export interface ModuleDeclaration {
    /**
     * The fully-qualified class name
     */
    name: string;
    /**
     * The generated typescript code
     */
    contents: string;
}

/**
 * A TypescriptDefinitionGenerator progress callback method
 */
export type ProgressCallback = (classname: string) => void;

declare class ModifierClass extends JavaClass {
    public static isPublic(val: number): Promise<boolean>;
    public static isStatic(val: number): Promise<boolean>;
    public static isStaticSync(val: number): boolean;
    public static isFinal(val: number): Promise<boolean>;
    public static isAbstract(val: number): Promise<boolean>;
}

declare class TypeClass extends JavaClass {
    public getTypeName(): Promise<string>;
}

declare class DeclaredMethodClass extends JavaClass {
    public getModifiers(): Promise<number>;
    public getName(): Promise<string>;
    public getReturnType(): Promise<TypeClass>;
    public getParameterTypes(): Promise<TypeClass[]>;
}

declare class DeclaredConstructorClass extends JavaClass {
    public getModifiers(): Promise<number>;
    public getParameterTypes(): Promise<TypeClass[]>;
}

declare class ClassClass extends JavaClass {
    public getMethods(): Promise<DeclaredMethodClass[]>;
    public getDeclaredConstructors(): Promise<DeclaredConstructorClass[]>;
    public getFields(): Promise<FieldClass[]>;
    public getModifiers(): Promise<number>;
    public isInterface(): Promise<boolean>;
}

declare class FieldClass extends JavaClass {
    public getModifiers(): Promise<number>;
    public getName(): Promise<string>;
    public getNameSync(): string;
    public getType(): Promise<TypeClass>;
}

/**
 * A list of methods which probably never return null
 */
const nonNullReturnMethods: string[] = [
    'toString',
    'wait',
    'getClass',
    'hashCode',
    'notify',
    'notifyAll',
    'equals',
];

/**
 * A class to generate typescript definitions for java classes.
 * Converts the given class and all of its dependencies to typescript.
 *
 * ## Example
 * ```ts
 * import { TypescriptDefinitionGenerator } from 'java-bridge';
 *
 * const generator = new TypescriptDefinitionGenerator('java.lang.String');
 * // Generate the typescript definitions
 * const definitions = await generator.generate();
 *
 * // Save the definitions to a directory
 * await TypescriptDefinitionGenerator.save(definitions, './project');
 * ```
 */
export default class TypescriptDefinitionGenerator {
    private usesBasicOrJavaType: boolean = false;
    private readonly additionalImports: string[] = [];
    private readonly importsToResolve: string[] = [];

    /**
     * Create a new `TypescriptDefinitionGenerator` instance
     *
     * @param classname the fully-qualified name of the class to generate a typescript definition for
     * @param progressCallback a callback method to be called every time a java class is
     *                         converted to typescript
     * @param resolvedImports a list of imports that have already been resolved.
     *                        This is used to prevent converting a class multiple times
     */
    public constructor(
        private readonly classname: string,
        private readonly progressCallback: ProgressCallback | null = null,
        private readonly resolvedImports: string[] = []
    ) {}

    private static async convertMethods(
        methods: DeclaredMethodClass[]
    ): Promise<Record<string, MethodDeclaration[]>> {
        const Modifier = await importClassAsync<typeof ModifierClass>(
            'java.lang.reflect.Modifier'
        );

        const result: Record<string, MethodDeclaration[]> = {};
        for (const method of methods) {
            const modifiers = await method.getModifiers();
            if (await Modifier.isPublic(modifiers)) {
                const name = await method.getName();
                const returnType = await method.getReturnType();
                const parameterTypes = await method.getParameterTypes();

                const data: MethodDeclaration = {
                    returnType: await returnType.getTypeName(),
                    parameters: await Promise.all(
                        parameterTypes.map((p) => p.getTypeName())
                    ),
                    isStatic: await Modifier.isStatic(modifiers),
                };

                if (Object.hasOwn(result, name)) {
                    result[name].push(data);
                } else {
                    result[name] = [data];
                }
            }
        }

        return result;
    }

    private async convertFields(
        fields: FieldClass[]
    ): Promise<ts.PropertyDeclaration[]> {
        const Modifier = await importClassAsync<typeof ModifierClass>(
            'java.lang.reflect.Modifier'
        );

        const res: ts.PropertyDeclaration[] = [];
        for (const field of fields) {
            const modifiers = await field.getModifiers();
            if (await Modifier.isPublic(modifiers)) {
                const name = await field.getName();
                const type = await field.getType();
                const typeName = await type.getTypeName();

                const tsModifiers: ts.ModifierLike[] = [
                    ts.factory.createModifier(SyntaxKind.PublicKeyword),
                ];
                if (await Modifier.isStatic(modifiers)) {
                    tsModifiers.push(
                        ts.factory.createModifier(SyntaxKind.StaticKeyword)
                    );
                }

                if (await Modifier.isFinal(modifiers)) {
                    tsModifiers.push(
                        ts.factory.createModifier(SyntaxKind.ReadonlyKeyword)
                    );
                }

                let declaration = ts.factory.createPropertyDeclaration(
                    tsModifiers,
                    name,
                    undefined,
                    this.javaTypeToTypescriptType(typeName, true),
                    undefined
                );

                declaration = ts.addSyntheticLeadingComment(
                    declaration,
                    ts.SyntaxKind.SingleLineCommentTrivia,
                    ` ================== Field ${name} ==================`,
                    true
                );

                res.push(
                    ts.addSyntheticLeadingComment(
                        declaration,
                        ts.SyntaxKind.MultiLineCommentTrivia,
                        `*\n * Original type: '${await type.getTypeName()}'\n `,
                        true
                    )
                );
            }
        }

        return res;
    }

    private async isAbstractOrInterface(
        classType: ClassClass
    ): Promise<boolean> {
        const Modifier = await importClassAsync<typeof ModifierClass>(
            'java.lang.reflect.Modifier'
        );

        return (
            (await classType.isInterface()) ||
            (await Modifier.isAbstract(await classType.getModifiers()))
        );
    }

    private createPrivateConstructor(): ts.ClassElement {
        const declaration = ts.factory.createConstructorDeclaration(
            [ts.factory.createModifier(ts.SyntaxKind.PrivateKeyword)],
            [],
            ts.factory.createBlock(
                [
                    ts.factory.createExpressionStatement(
                        ts.factory.createCallExpression(
                            ts.factory.createSuper(),
                            [],
                            []
                        )
                    ),
                ],
                true
            )
        );

        return ts.addSyntheticLeadingComment(
            declaration,
            ts.SyntaxKind.MultiLineCommentTrivia,
            '*\n * Private constructor to prevent instantiation\n' +
                ' * as this is either an abstract class or an interface\n ',
            true
        );
    }

    private async convertConstructors(
        constructors: DeclaredConstructorClass[]
    ): Promise<ts.ClassElement[]> {
        const Modifier = await importClassAsync<typeof ModifierClass>(
            'java.lang.reflect.Modifier'
        );
        const types: string[][] = [];

        for (const constructor of constructors) {
            const modifiers = await constructor.getModifiers();
            if (await Modifier.isPublic(modifiers)) {
                const parameterTypes = await constructor.getParameterTypes();
                types.push(
                    await Promise.all(
                        parameterTypes.map((p) => p.getTypeName())
                    )
                );
            }
        }

        const tsConstructors = types.map((t, i) => {
            const params = t.map(this.convertParameter.bind(this));
            let declaration = ts.factory.createConstructorDeclaration(
                [ts.factory.createModifier(ts.SyntaxKind.PublicKeyword)],
                params,
                undefined
            );
            if (i === 0) {
                declaration = ts.addSyntheticLeadingComment(
                    declaration,
                    ts.SyntaxKind.SingleLineCommentTrivia,
                    ` ================== Constructors ==================`,
                    true
                );
            }

            if (t.length > 0) {
                declaration = ts.addSyntheticLeadingComment(
                    declaration,
                    ts.SyntaxKind.MultiLineCommentTrivia,
                    '*\n' +
                        t
                            .map(
                                (p, i) =>
                                    ` * @param var${i} original type: '${p}'\n`
                            )
                            .join('') +
                        ' ',
                    true
                );
            }

            return declaration;
        });

        const newInstanceMethods = types.map((t, i) => {
            return this.createMethod(
                {
                    returnType: this.classname,
                    parameters: t,
                    isStatic: true,
                },
                'newInstance',
                i,
                false,
                true
            );
        });

        return [...newInstanceMethods, ...tsConstructors];
    }

    private primitiveToClassType(type: string): string {
        switch (type) {
            case 'boolean':
                return 'java.lang.Boolean';
            case 'byte':
                return 'java.lang.Byte';
            case 'char':
                return 'java.lang.Character';
            case 'short':
                return 'java.lang.Short';
            case 'int':
                return 'java.lang.Integer';
            case 'long':
                return 'java.lang.Long';
            case 'float':
                return 'java.lang.Float';
            case 'double':
                return 'java.lang.Double';
            default:
                return type;
        }
    }

    private isPrimitive(type: string): boolean {
        return [
            'boolean',
            'byte',
            'char',
            'short',
            'int',
            'long',
            'float',
            'double',
        ].includes(type);
    }

    private javaTypeToTypescriptType(
        javaType: string,
        isParam: boolean,
        strictNullTypes: boolean = true
    ): ts.TypeNode {
        const createType = (type: ts.TypeNode): ts.TypeNode => {
            if (strictNullTypes) {
                return ts.factory.createUnionTypeNode([
                    type,
                    ts.factory.createLiteralTypeNode(ts.factory.createNull()),
                ]);
            } else {
                return type;
            }
        };

        switch (javaType) {
            case 'byte[]':
            case 'java.lang.Byte[]':
                return createType(ts.factory.createTypeReferenceNode('Buffer'));
        }

        if (javaType.endsWith('[]')) {
            return createType(
                ts.factory.createArrayTypeNode(
                    this.javaTypeToTypescriptType(
                        javaType.substring(0, javaType.length - 2),
                        isParam
                    )
                )
            );
        }

        const createTypeReferenceNode = (
            name: string
        ): ts.TypeReferenceNode => {
            if (!this.resolvedImports.includes(name)) {
                this.additionalImports.push(name);
            }

            this.importsToResolve.push(name);
            const isSelf = name === this.classname && isParam;
            return ts.factory.createTypeReferenceNode(
                name === this.classname
                    ? name.substring(name.lastIndexOf('.') + 1) +
                          (isSelf ? 'Class' : '')
                    : name.replaceAll('.', '_')
            );
        };

        const createUnion = (
            type: ts.KeywordTypeSyntaxKind,
            ...additionalTypes: ts.KeywordTypeSyntaxKind[]
        ): ts.UnionTypeNode => {
            const types: ts.TypeNode[] = [
                ts.factory.createKeywordTypeNode(type),
            ];

            if (!this.isPrimitive(javaType) && strictNullTypes) {
                types.push(
                    ts.factory.createLiteralTypeNode(ts.factory.createNull())
                );
            }

            if (!isParam) {
                return ts.factory.createUnionTypeNode(types);
            }

            return ts.factory.createUnionTypeNode([
                createTypeReferenceNode(this.primitiveToClassType(javaType)),
                ...additionalTypes.map((t) =>
                    ts.factory.createKeywordTypeNode(t)
                ),
                ...types,
            ]);
        };

        switch (javaType) {
            case 'int':
            case 'java.lang.Integer':
            case 'float':
            case 'java.lang.Float':
            case 'double':
            case 'java.lang.Double':
            case 'byte':
            case 'java.lang.Byte':
            case 'short':
            case 'java.lang.Short':
                return createUnion(SyntaxKind.NumberKeyword);
            case 'long':
            case 'java.lang.Long':
                return createUnion(
                    SyntaxKind.NumberKeyword,
                    SyntaxKind.BigIntKeyword
                );
            case 'char':
            case 'java.lang.Character':
            case 'java.lang.String':
                return createType(
                    ts.factory.createKeywordTypeNode(SyntaxKind.StringKeyword)
                );
            case 'boolean':
            case 'java.lang.Boolean':
                return createUnion(SyntaxKind.BooleanKeyword);
            case 'void':
            case 'java.lang.Void':
                return ts.factory.createKeywordTypeNode(SyntaxKind.VoidKeyword);
            case 'java.lang.Object':
                this.usesBasicOrJavaType = true;
                return createType(
                    ts.factory.createTypeReferenceNode('BasicOrJavaType')
                );
            default:
                return createType(createTypeReferenceNode(javaType));
        }
    }

    private convertParameter(
        param: string,
        index: number
    ): ts.ParameterDeclaration {
        const name = 'var' + index;
        const type = this.javaTypeToTypescriptType(param, true);
        return ts.factory.createParameterDeclaration(
            undefined,
            undefined,
            name,
            undefined,
            type
        );
    }

    private convertParameters(params: MethodDeclaration) {
        return params.parameters.map(this.convertParameter.bind(this));
    }

    private static createMethodComment(declaration: MethodDeclaration) {
        return (
            '*\n' +
            declaration.parameters
                .map((p, i) => ` * @param var${i} original type: '${p}'\n`)
                .join('') +
            ` * @return original return type: '${declaration.returnType}'\n `
        );
    }

    private createMethod(
        m: MethodDeclaration,
        name: string,
        i: number,
        isSync: boolean,
        nonNullReturnType: boolean
    ): ts.MethodDeclaration {
        const publicMod = ts.factory.createModifier(
            ts.SyntaxKind.PublicKeyword
        );
        const staticMod = ts.factory.createModifier(
            ts.SyntaxKind.StaticKeyword
        );

        const modifiers: ts.Modifier[] = [publicMod];
        if (m.isStatic) {
            modifiers.push(staticMod);
        }

        let returnType = this.javaTypeToTypescriptType(
            m.returnType,
            false,
            !nonNullReturnType
        );
        if (!isSync) {
            returnType = ts.factory.createTypeReferenceNode(
                ts.factory.createIdentifier('Promise'),
                [returnType]
            );
        }

        let declaration = ts.factory.createMethodDeclaration(
            modifiers,
            undefined,
            name + (isSync ? 'Sync' : ''),
            undefined,
            undefined,
            this.convertParameters(m),
            returnType,
            undefined
        );

        if (i === 0) {
            declaration = ts.addSyntheticLeadingComment(
                declaration,
                ts.SyntaxKind.SingleLineCommentTrivia,
                ` ================== Method ${name} ==================`,
                true
            );
        }

        return ts.addSyntheticLeadingComment(
            declaration,
            ts.SyntaxKind.MultiLineCommentTrivia,
            TypescriptDefinitionGenerator.createMethodComment(m),
            true
        );
    }

    private convertMethod(
        method: MethodDeclaration[],
        name: string
    ): ts.MethodDeclaration[] {
        const res: ts.MethodDeclaration[] = [];

        for (let i = 0; i < method.length; i++) {
            const m = method[i];

            const nonNullReturnType = nonNullReturnMethods.includes(name);
            res.push(
                this.createMethod(m, name, i, false, nonNullReturnType),
                this.createMethod(m, name, i, true, nonNullReturnType)
            );
        }

        return res;
    }

    private getAdditionalImports() {
        const getPath = (i: string) => {
            const thisSplit: (string | null)[] = this.classname.split('.');
            const importSplit: (string | null)[] = i.split('.');

            for (let j = 0; j < thisSplit.length; j++) {
                if (importSplit[j] === thisSplit[j]) {
                    thisSplit[j] = null;
                    importSplit[j] = null;
                } else {
                    break;
                }
            }

            return (
                './' +
                thisSplit
                    .filter((e) => !!e)
                    .map(() => '')
                    .join('../') +
                importSplit.filter((e) => !!e).join('/')
            );
        };

        const unique = <T>(value: T, index: number, self: T[]) => {
            return self.indexOf(value) === index;
        };

        return this.importsToResolve
            .filter((i) => i != this.classname)
            .filter(unique)
            .map((i) =>
                ts.factory.createImportDeclaration(
                    undefined,
                    ts.factory.createImportClause(
                        false,
                        undefined,
                        ts.factory.createNamedImports([
                            ts.factory.createImportSpecifier(
                                false,
                                ts.factory.createIdentifier(
                                    i.substring(i.lastIndexOf('.') + 1)
                                ),
                                ts.factory.createIdentifier(
                                    i.replaceAll('.', '_')
                                )
                            ),
                        ])
                    ),
                    ts.factory.createStringLiteral(getPath(i))
                )
            );
    }

    private getImports(): ts.ImportDeclaration {
        const importElements = [
            ts.factory.createImportSpecifier(
                false,
                undefined,
                ts.factory.createIdentifier('importClass')
            ),
            ts.factory.createImportSpecifier(
                false,
                undefined,
                ts.factory.createIdentifier('JavaClass')
            ),
        ];

        if (this.usesBasicOrJavaType) {
            importElements.push(
                ts.factory.createImportSpecifier(
                    false,
                    undefined,
                    ts.factory.createIdentifier('BasicOrJavaType')
                )
            );
        }

        const imports = ts.factory.createNamedImports(importElements);
        return ts.factory.createImportDeclaration(
            undefined,
            ts.factory.createImportClause(false, undefined, imports),
            ts.factory.createStringLiteral('java-bridge')
        );
    }

    private getExportStatement(
        simpleName: string,
        isAbstractOrInterface: boolean
    ) {
        const statement = ts.factory.createClassDeclaration(
            [ts.factory.createModifier(ts.SyntaxKind.ExportKeyword)],
            simpleName,
            undefined,
            [
                ts.factory.createHeritageClause(ts.SyntaxKind.ExtendsKeyword, [
                    ts.factory.createExpressionWithTypeArguments(
                        ts.factory.createIdentifier(
                            `importClass<typeof ${simpleName}Class>("${this.classname}")`
                        ),
                        undefined
                    ),
                ]),
            ],
            isAbstractOrInterface ? [this.createPrivateConstructor()] : []
        );

        return [
            ts.addSyntheticLeadingComment(
                statement,
                SyntaxKind.MultiLineCommentTrivia,
                `*\n * Class ${this.classname}.\n *\n` +
                    ' * This actually imports the java class for further use.\n' +
                    ` * The class ${simpleName}Class only defines types, this is the class you should actually import.\n` +
                    ' * Please note that this statement imports the underlying java class at runtime, which may take a while.\n' +
                    ' * This was generated by java-bridge.\n * You should probably not edit this.\n ',
                true
            ),
            ts.factory.createExportDefault(
                ts.factory.createIdentifier(simpleName)
            ),
        ];
    }

    private getText(nodes: (ts.Node | null)[]) {
        return nodes
            .map(
                (n) =>
                    (n &&
                        ts
                            .createPrinter({ newLine: ts.NewLineKind.LineFeed })
                            .printNode(
                                ts.EmitHint.Unspecified,
                                n,
                                sourceFile
                            )) ||
                    ''
            )
            .join('\n');
    }

    /**
     * Generates the typescript definition for the given class.
     *
     * @returns the generated typescript definitions
     */
    public async generate(): Promise<ModuleDeclaration[]> {
        if (this.resolvedImports.includes(this.classname)) {
            return [];
        }

        this.resolvedImports.push(this.classname);
        if (this.progressCallback) {
            this.progressCallback(this.classname);
        }

        const Class = await importClassAsync(this.classname);
        const cls = Class.class as ClassClass;

        const simpleName = this.classname.substring(
            this.classname.lastIndexOf('.') + 1
        );

        function onlyUnique<T extends { getNameSync(): string }>(
            value: T,
            index: number,
            self: T[]
        ): boolean {
            return (
                self.findIndex(
                    (el) => value.getNameSync() === el.getNameSync()
                ) === index
            );
        }

        const fields = (await cls.getFields()).filter(onlyUnique);
        const methods = await cls.getMethods();

        const classMembers: ts.ClassElement[] = await this.convertFields(
            fields
        );

        const convertedMethods =
            await TypescriptDefinitionGenerator.convertMethods(methods);
        for (const [key, method] of Object.entries(convertedMethods)) {
            classMembers.push(...this.convertMethod(method, key));
        }

        const isAbstractOrInterface = await this.isAbstractOrInterface(cls);
        if (!isAbstractOrInterface) {
            const constructors = await cls.getDeclaredConstructors();
            const convertedConstructors = await this.convertConstructors(
                constructors
            );
            classMembers.push(...convertedConstructors);
        }

        let tsClass = ts.factory.createClassDeclaration(
            [
                ts.factory.createModifier(ts.SyntaxKind.ExportKeyword),
                ts.factory.createModifier(ts.SyntaxKind.DeclareKeyword),
            ],
            simpleName + 'Class',
            undefined,
            [
                ts.factory.createHeritageClause(ts.SyntaxKind.ExtendsKeyword, [
                    ts.factory.createExpressionWithTypeArguments(
                        ts.factory.createIdentifier('JavaClass'),
                        undefined
                    ),
                ]),
            ],
            classMembers
        );

        tsClass = ts.addSyntheticLeadingComment(
            tsClass,
            ts.SyntaxKind.MultiLineCommentTrivia,
            `*\n * This class just defines types, you should import ${simpleName} instead of this.\n` +
                ' * This was generated by java-bridge.\n * You should probably not edit this.\n ',
            true
        );

        const sourceText = this.getText([
            this.getImports(),
            ...this.getAdditionalImports(),
            null,
            tsClass,
            null,
            ...this.getExportStatement(simpleName, isAbstractOrInterface),
        ]);

        const res: ModuleDeclaration[] = [];
        for (const imported of this.additionalImports) {
            const generator = new TypescriptDefinitionGenerator(
                imported,
                this.progressCallback,
                this.resolvedImports
            );
            const generated = await generator.generate();
            res.push(...generated);
        }

        res.push({
            name: this.classname,
            contents: sourceText,
        });

        return res;
    }

    /**
     * Save the converted classes to the given directory.
     *
     * @param declarations the declarations to save
     * @param sourceDir the directory to save the files to
     */
    public static async save(
        declarations: ModuleDeclaration[],
        sourceDir: string
    ): Promise<void> {
        for (const declaration of declarations) {
            const p = declaration.name.split('.');
            p[p.length - 1] = p[p.length - 1] + '.ts';

            const filePath = path.join(sourceDir, ...p);
            await fs.promises.mkdir(path.dirname(filePath), {
                recursive: true,
            });
            await fs.promises.writeFile(filePath, declaration.contents, {
                encoding: 'utf8',
            });
        }
    }
}
