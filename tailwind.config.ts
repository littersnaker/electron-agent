// tailwind.config.js
module.exports = {
  theme: {
    extend: {},
  },
  plugins: [
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('@tailwindcss/typography'), // 🔥 加上这一行
  ],
}