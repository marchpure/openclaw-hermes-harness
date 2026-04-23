export const safeJSONStringify = (obj: unknown) => {
  try {
    return JSON.stringify(obj);
  } catch (error) {
    console.error("stringify error:", error);
    return "";
  }
};
