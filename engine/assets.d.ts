// The engine bundler inlines the status page as a string.
declare module "*.html" {
  const content: string;
  export default content;
}
