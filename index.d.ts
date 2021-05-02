declare namespace native {
    const java: typeof java_instance;
}

declare type basic_type = string | number | boolean;
declare type basic_or_java = basic_type | java_object;

export class java_instance {
    public readonly version: string;
    public readonly wantedVersion: string;

    public constructor(jvmPath: string, jvmVersion: string);

    public get loadedJars(): string[];

    public getClass(classname: string): java_class_proxy;

    public appendToClasspath(path: string): void;
}

export abstract class java_object {
}

declare class java_class_proxy extends java_object {
    public 'class.name': string;
    public 'java.instance': java_instance;

    public getClassConstructor(): java_instance_proxy_constructor;
}

declare type java_instance_proxy_constructor = typeof java_instance_proxy;

export class java_instance_proxy extends java_object {
    public static readonly 'class.proxy.instance': java_class_proxy;
    public readonly 'java.instance': java_instance;

    public constructor(...args: any[]);
}

declare namespace java {
    namespace classpath {
        function append(path: string): void;
    }

    function createJVM(version: string, jvmPath?: string): void;

    function importClass(classname: string): java_instance_proxy_constructor;

    function getJavaInstance(): java_instance;
}

export default java;