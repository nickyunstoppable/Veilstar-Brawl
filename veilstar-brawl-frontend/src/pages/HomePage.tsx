import { motion } from 'framer-motion';
import LandingLayout from '../components/landing/LandingLayout';
import DecorativeLine from '../components/landing/DecorativeLine';

export default function HomePage() {
  const fadeInUp = {
    hidden: { opacity: 0, y: 20 },
    visible: { opacity: 1, y: 0, transition: { duration: 0.6 } },
  };

  const staggerContainer = {
    hidden: { opacity: 0 },
    visible: {
      opacity: 1,
      transition: {
        staggerChildren: 0.2,
      },
    },
  };

  return (
    <LandingLayout>
      <div className="relative w-full overflow-hidden">
        {/* Global Vertical Grid Lines */}
        <div className="absolute top-[-90px] bottom-0 left-[70.5px] w-px bg-[#E03609]/30 hidden md:block z-0 pointer-events-none" />
        <div className="absolute top-[-90px] bottom-0 right-[70.5px] w-px bg-[#F0B71F]/30 hidden md:block z-0 pointer-events-none" />

        {/* Hero Section */}
        <section className="relative mt-32 pt-32 pb-32 min-h-screen flex flex-col justify-center">
          <DecorativeLine
            className="absolute top-[-90px] left-0 right-0 z-20"
            variant="left-red-right-gold"
          />

          <div className="container mx-auto px-6 lg:px-12 xl:px-24 relative z-10">
            {/* Main Layout */}
            <div className="relative mb-24">
              {/* Title BEHIND the character */}
              <div className="absolute top-[7%] left-1/2 transform -translate-x-1/2 -translate-y-1/2 w-full text-center z-0 pointer-events-none px-4">
                <motion.h1
                  initial={{ opacity: 0, y: 50, scale: 0.9 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  transition={{ duration: 1, ease: 'easeOut' }}
                  className="text-[40px] xs:text-[50px] sm:text-[64px] md:text-[72px] lg:text-[100px] xl:text-[130px] font-bold leading-tight md:leading-none font-['Orbitron'] text-white opacity-90 tracking-wider break-words md:whitespace-nowrap"
                >
                  VEILSTAR BRAWL
                </motion.h1>
              </div>

              {/* Character Image */}
              <div className="relative z-10 flex justify-center items-end">
                <div className="relative">
                  <motion.img
                    initial={{ opacity: 0, y: 100 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.8, delay: 0.2, ease: 'easeOut' }}
                    src="/assets/hero.webp"
                    alt="Cyberpunk Fighter"
                    className="w-auto h-[300px] sm:h-[400px] md:h-[600px] lg:h-[700px] object-contain drop-shadow-[0_0_30px_rgba(240,183,31,0.3)] [mask-image:linear-gradient(to_bottom,black_80%,transparent_100%)]"
                  />
                  {/* Blending Overlay */}
                  <div className="absolute inset-0 bg-gradient-to-t from-black/40 via-transparent to-transparent pointer-events-none z-20 h-full w-full bottom-0" />
                </div>
              </div>

              {/* "True Ownership" - Left Side */}
              <motion.div
                initial={{ x: -50, opacity: 0 }}
                animate={{ x: 0, opacity: 1 }}
                transition={{ duration: 0.8, delay: 0.5 }}
                className="absolute top-[40%] left-0 lg:left-10 z-20 hidden md:block max-w-[250px]"
              >
                <div className="flex items-center gap-4 mb-2">
                  <div className="w-1.5 h-1.5 rounded-full bg-white" />
                  <h3 className="text-xl font-semibold font-['Orbitron'] text-white">
                    True Ownership
                  </h3>
                </div>
                <p className="text-[#999] text-sm leading-relaxed">
                  Your fighters, your stats, your history. All verifiable on the Stellar blockchain.
                </p>
              </motion.div>

              {/* "Live Matches" - Right Side */}
              <motion.div
                initial={{ x: 50, opacity: 0 }}
                animate={{ x: 0, opacity: 1 }}
                transition={{ duration: 0.8, delay: 0.5 }}
                className="absolute top-[40%] right-0 lg:right-10 z-20 hidden md:block max-w-[250px] text-right"
              >
                <h3 className="text-xl font-semibold font-['Orbitron'] text-white mb-2 leading-tight">
                  LIVE MATCHES
                  <br />
                  AND UPDATES
                </h3>
                <p className="text-[#999] text-sm leading-relaxed mb-6">
                  Spectate live 1v1 battles with synced round state, turn timers, and match updates.
                </p>
                <a href="#zk">
                  <motion.div whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }}>
                    <button
                      className="text-white border-0 hover:opacity-90 font-['Orbitron'] text-sm px-6 py-2 rounded-lg"
                      style={{ background: 'linear-gradient(90deg, #F0B71F, #E03609)' }}
                    >
                      Watch Live
                    </button>
                  </motion.div>
                </a>
              </motion.div>
            </div>

            {/* Bottom Cards Section */}
            <motion.div
              variants={staggerContainer}
              initial="hidden"
              whileInView="visible"
              viewport={{ once: true, amount: 0.3 }}
              className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-12 gap-6 md:gap-8 items-end relative z-20"
            >
              {/* Left Card - 1 BPS */}
              <motion.div
                variants={fadeInUp}
                className="sm:col-span-2 md:col-span-4 lg:col-span-5 relative rounded-[20px] border border-[#F0B71F]/30 bg-black/40 backdrop-blur-md p-4 sm:p-6 group hover:border-[#F0B71F] transition-colors"
              >
                <div className="flex gap-3 sm:gap-4 items-center">
                  <img
                    src="/assets/second-hero.webp"
                    alt="Stellar Speed"
                    className="w-20 h-20 sm:w-24 sm:h-24 rounded-[12px] object-cover border border-[#E03609]/30 flex-shrink-0"
                  />
                  <div className="flex-1 min-w-0">
                    <h2
                      className="text-xl sm:text-2xl md:text-3xl font-bold font-['Orbitron'] mb-1 text-[#F0B71F]"
                    >
                      ZK PROOFS
                    </h2>
                    <h3 className="text-white font-medium mb-1 text-sm sm:text-base">
                      Hidden Strategies
                    </h3>
                    <p className="text-[#999] text-xs leading-5 line-clamp-2">
                      Moves verified instantly with zero-knowledge proofs. True fairness.
                    </p>
                  </div>
                </div>
              </motion.div>

              {/* Center Text - Micro Fees */}
              <motion.div
                variants={fadeInUp}
                className="sm:col-span-2 md:col-span-4 lg:col-span-4 text-center pb-4"
              >
                <h3 className="text-xl sm:text-2xl md:text-3xl font-semibold uppercase mb-2 font-['Orbitron'] text-white tracking-widest">
                  MICRO <br />{' '}
                  <span className="text-[#E03609] font-bold">
                    FEES
                  </span>
                </h3>
                <p className="text-[#999] text-sm max-w-[200px] mx-auto">
                  Fast testnet flow with wallet-signed actions and low-friction match progression.
                </p>
              </motion.div>

              {/* Right Card - 100% Fair Play */}
              <motion.div
                variants={fadeInUp}
                className="sm:col-span-2 md:col-span-4 lg:col-span-3"
              >
                <div className="rounded-[20px] border border-[#F0B71F]/30 bg-black/40 backdrop-blur-md p-6 sm:p-8 text-center h-full flex flex-col justify-center items-center hover:border-[#E03609] transition-colors">
                  <h2
                    className="text-4xl sm:text-5xl md:text-6xl font-bold mb-2 font-['Orbitron'] bg-clip-text text-transparent"
                    style={{ backgroundImage: 'linear-gradient(90deg, #F0B71F, #E03609)' }}
                  >
                    100%
                  </h2>
                  <p className="text-base sm:text-lg font-medium text-white font-['Orbitron']">
                    Fair Play
                  </p>
                  <p className="text-[#999] text-xs mt-2">Verifiable Logic</p>
                </div>
              </motion.div>
            </motion.div>
          </div>

          <DecorativeLine
            className="absolute bottom-[-90px] left-0 right-0 z-20"
            variant="left-red-right-gold"
          />
        </section>

        {/* About Section 1 - Skill Meets Strategy */}
        <motion.section
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, amount: 0.3 }}
          variants={staggerContainer}
          className="py-20"
        >
          <div className="container mx-auto px-6 lg:px-12 xl:px-24">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 items-center">
              <motion.div variants={fadeInUp}>
                <h2 className="text-4xl lg:text-[57px] font-bold leading-tight mb-8 font-['Orbitron']">
                  <span className="text-white">Where </span>
                  <span className="text-[#F0B71F]">
                    Skill Meets{' '}
                  </span>
                  <span className="text-white">Strategy.</span>
                </h2>
                <p className="text-[#999] text-lg leading-8 mb-12">
                  Veilstar Brawl is a turn-based 1v1 fighter on Stellar. Each turn you choose punch,
                  kick, block, or special while managing health, energy, and guard pressure. Every
                  round starts with Power Surge picks, and private rooms can run a 3-phase hidden
                  flow: pick surges, plan moves, then resolve.
                </p>

                {/* Stats */}
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-8">
                  <motion.div variants={fadeInUp}>
                    <h3
                      className="text-4xl lg:text-[47px] font-semibold mb-2 font-['Orbitron'] text-[#F0B71F]"
                    >
                      ZK
                    </h3>
                    <p className="text-white text-lg">Noir Proofs</p>
                  </motion.div>
                  <motion.div variants={fadeInUp}>
                    <h3
                      className="text-4xl lg:text-[47px] font-semibold mb-2 font-['Orbitron'] text-[#E03609]"
                    >
                      P2P
                    </h3>
                    <p className="text-white text-lg">Direct Battles</p>
                  </motion.div>
                  <motion.div variants={fadeInUp}>
                    <h3
                      className="text-4xl lg:text-[47px] font-semibold mb-2 font-['Orbitron'] text-[#F0B71F]"
                    >
                      Soroban
                    </h3>
                    <p className="text-white text-lg">Smart Contracts</p>
                  </motion.div>
                </div>
              </motion.div>

              <motion.div variants={fadeInUp}>
                {/* Arena image */}
                <div className="w-full aspect-square max-w-[500px] mx-auto rounded-lg shadow-2xl shadow-[#E03609]/20 border border-[#F0B71F]/20 overflow-hidden relative">
                  <img
                    src="/assets/4.webp"
                    alt="Arena"
                    className="w-full h-full object-cover"
                  />
                  <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent" />
                  <div className="absolute inset-0 flex items-center justify-center text-center z-10">
                    <div>
                      <div className="text-6xl sm:text-7xl font-bold font-['Orbitron'] text-[#F0B71F] mb-4 drop-shadow-[0_0_20px_rgba(240,183,31,0.8)]">
                        VS
                      </div>
                      <p className="text-white text-sm font-['Orbitron'] drop-shadow-lg">THE ARENA AWAITS</p>
                    </div>
                  </div>
                </div>
              </motion.div>
            </div>
          </div>
        </motion.section>

        {/* ZK Section */}
        <motion.section
          id="zk"
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, amount: 0.3 }}
          variants={staggerContainer}
          className="py-20"
        >
          <div className="container mx-auto px-6 lg:px-12 xl:px-24">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 items-center">
              <motion.div variants={fadeInUp} className="order-2 lg:order-1">
                {/* ZK Proof visualization with background */}
                <div className="w-full aspect-[4/3] rounded-lg shadow-2xl shadow-[#F0B71F]/20 border border-[#F0B71F]/20 overflow-hidden relative">
                  {/* Background image */}
                  <div className="absolute inset-0">
                    <img
                      src="/assets/6.webp"
                      alt="ZK Proof"
                      className="w-full h-full object-cover"
                    />
                  </div>
                  {/* Overlay gradient */}
                  <div className="absolute inset-0 bg-gradient-to-br from-[#0a0a1a]/90 to-[#0a1a2e]/85" />
                  <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_50%,rgba(240,183,31,0.08),transparent_60%)]" />
                  
                  {/* Code overlay */}
                  <div className="relative z-10 w-full h-full flex items-center justify-center p-8">
                    <div className="space-y-4 backdrop-blur-sm bg-black/30 p-6 rounded-lg border border-[#F0B71F]/20">
                      <div className="flex items-center gap-3 text-[#F0B71F]/80 font-mono text-xs sm:text-sm">
                        <span className="text-[#E03609]">fn</span> main(
                      </div>
                      <div className="pl-6 text-[#999] font-mono text-xs sm:text-sm">
                        match_id: Field,
                      </div>
                      <div className="pl-6 text-[#999] font-mono text-xs sm:text-sm">
                        round_number: u32,
                      </div>
                      <div className="pl-6 text-[#999] font-mono text-xs sm:text-sm">
                        turn_number: u32,
                      </div>
                      <div className="pl-6 text-[#999] font-mono text-xs sm:text-sm">
                        player_address: Field,
                      </div>
                      <div className="pl-6 text-[#999] font-mono text-xs sm:text-sm">
                        surge_card: u32,
                      </div>
                      <div className="pl-6 text-[#999] font-mono text-xs sm:text-sm">
                        selected_move: u32,
                      </div>
                      <div className="pl-6 text-[#999] font-mono text-xs sm:text-sm">
                        nonce: Field,
                      </div>
                      <div className="text-[#F0B71F]/80 font-mono text-xs sm:text-sm">{') -> pub Field'}</div>
                      <div className="mt-4 p-3 rounded border border-[#F0B71F]/20 bg-[#F0B71F]/5">
                        <span className="text-[#F0B71F] text-xs font-['Orbitron']">
                          PROOF VERIFIED ✓
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              </motion.div>

              <motion.div variants={fadeInUp} className="order-1 lg:order-2">
                <h2 className="text-4xl lg:text-[55px] font-bold leading-tight mb-8 font-['Orbitron']">
                  <span className="text-white">Powered by </span>
                  <span className="text-[#F0B71F]">
                    Zero-Knowledge{' '}
                  </span>
                  <span className="text-white">Proofs</span>
                </h2>
                <p className="text-[#999] text-lg leading-8 mb-12">
                  Veilstar Brawl uses Noir-powered proofs and Stellar contracts for private-match
                  commitment checks and verifiable outcomes. In private rooms, surge picks and move
                  plans are committed first and revealed for verification before full turn playback.
                </p>

                {/* Join Card */}
                <div className="rounded-[20px] border border-[#F0B71F] bg-white/[0.04] backdrop-blur-[25.7px] p-8">
                  <div className="flex flex-col sm:flex-row gap-6 items-start">
                    <div className="w-24 h-24 sm:w-48 sm:h-48 rounded-[14px] flex-shrink-0 bg-gradient-to-br from-[#F0B71F]/20 to-[#E03609]/20 border border-[#F0B71F]/30 flex items-center justify-center">
                      <svg viewBox="0 0 60 60" className="w-16 h-16" fill="none">
                        <defs>
                          <linearGradient id="shieldGrad" x1="0" y1="0" x2="60" y2="60">
                            <stop offset="0%" stopColor="#F0B71F" />
                            <stop offset="100%" stopColor="#E03609" />
                          </linearGradient>
                        </defs>
                        <path
                          d="M30 5L8 15V30C8 44 17 52 30 57C43 52 52 44 52 30V15L30 5Z"
                          stroke="url(#shieldGrad)"
                          strokeWidth="2"
                          fill="none"
                        />
                        <text
                          x="30"
                          y="36"
                          textAnchor="middle"
                          fill="url(#shieldGrad)"
                          fontSize="14"
                          fontFamily="Orbitron"
                          fontWeight="bold"
                        >
                          ZK
                        </text>
                      </svg>
                    </div>
                    <div className="flex-1">
                      <h3 className="text-2xl lg:text-3xl font-medium mb-4 text-white font-['Orbitron']">
                        Enter the Arena
                      </h3>
                      <p className="text-[#999] text-lg leading-8 mb-4">
                        Connect your Stellar wallet to queue, create, or join matches. Practice mode
                        lets you train first, then jump into live PvP when you're ready.
                      </p>
                      <a
                        href="/play"
                        className="text-[#F0B71F] hover:text-[#E03609] font-semibold flex items-center gap-2 transition-colors"
                      >
                        Start Playing <span aria-hidden="true">&rarr;</span>
                      </a>
                    </div>
                  </div>
                </div>
              </motion.div>
            </div>
          </div>
        </motion.section>

        <DecorativeLine className="my-20" variant="left-red-right-gold" />

        {/* Banner Section */}
        <motion.section
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, amount: 0.3 }}
          variants={staggerContainer}
          className="py-20 relative"
        >
          <div className="container mx-auto px-6 lg:px-12 xl:px-24">
            <motion.div
              variants={fadeInUp}
              className="relative rounded-lg overflow-hidden min-h-[500px] flex items-center"
            >
              {/* Background image */}
              <div className="absolute inset-0">
                <img
                  src="/assets/5.webp"
                  alt="Arena background"
                  className="w-full h-full object-cover"
                />
              </div>
              {/* Background gradient overlays */}
              <div className="absolute inset-0 bg-gradient-to-br from-[#0a0a2e] via-[#1a0a3e]/40 to-transparent opacity-60" />
              <div className="absolute inset-0 bg-gradient-to-r from-[#010101] via-[#010101]/80 to-transparent" />

              <div className="relative z-10 w-full">
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 px-6 lg:px-12">
                  <div className="max-w-2xl">
                    <h2 className="text-4xl lg:text-[68px] font-bold leading-tight mb-8 font-['Orbitron'] text-white">
                      Ready to Brawl?
                    </h2>
                    <p className="text-[#999] text-lg leading-8 mb-8">
                      The arena is live on Stellar Testnet. Master move timing, energy economy,
                      and surge decisions across best-of rounds to climb and win.
                    </p>
                    <div className="flex flex-col sm:flex-row gap-4">
                      <a href="/play">
                        <motion.div whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }}>
                          <button
                            className="w-full sm:w-auto text-white border-0 hover:opacity-90 font-['Orbitron'] text-base sm:text-lg px-6 sm:px-8 py-4 sm:py-6 rounded-lg"
                            style={{ background: 'linear-gradient(90deg, #F0B71F, #E03609)' }}
                          >
                            Play Now
                          </button>
                        </motion.div>
                      </a>
                      <a href="#faq">
                        <motion.div whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }}>
                          <button className="w-full sm:w-auto border border-[#F0B71F] text-[#F0B71F] hover:bg-[#F0B71F]/10 font-['Orbitron'] text-base sm:text-lg px-6 sm:px-8 py-4 sm:py-6 rounded-lg bg-transparent">
                            Learn More
                          </button>
                        </motion.div>
                      </a>
                    </div>
                  </div>

                  {/* Navigation Card */}
                  <div className="hidden lg:block rounded-[20px] border border-[#F0B71F] bg-black/40 backdrop-blur-xl p-12">
                    <div className="space-y-6">
                      {[
                        { title: 'Quick Play', color: 'gold', href: '/play' },
                        { title: 'ZK Proofs', color: 'red', href: '#zk' },
                        { title: 'Features', color: 'gold', href: '#features' },
                        { title: 'FAQ', color: 'red', href: '#faq' },
                      ].map((item, index) => (
                        <a
                          key={index}
                          href={item.href}
                          className="flex items-center justify-between group"
                          onClick={(e) => {
                            if (item.href.startsWith('#')) {
                              e.preventDefault();
                              const el = document.getElementById(item.href.slice(1));
                              el?.scrollIntoView({ behavior: 'smooth' });
                            }
                          }}
                        >
                          <div className="flex items-center gap-4">
                            <div
                              className={`w-4 h-4 ${item.color === 'gold' ? 'bg-[#F0B71F]' : 'bg-[#E03609]'} transform rotate-45 group-hover:rotate-90 transition-transform duration-300`}
                            />
                            <span className="text-2xl font-semibold capitalize group-hover:text-[#F0B71F] transition-colors font-['Orbitron'] text-white">
                              {item.title}
                            </span>
                          </div>
                          <div className="rotate-45 group-hover:translate-x-1 group-hover:-translate-y-1 transition-transform">
                            <svg className="w-9 h-9" fill="white" viewBox="0 0 25 24">
                              <path d="M19.799 13.2251L1.44367 13.2251C1.06557 13.2251 0.73043 13.079 0.438257 12.7869C0.146085 12.4947 -1.64197e-06 12.1596 -1.91593e-06 11.7815C-8.62254e-07 11.4033 0.146085 11.0682 0.438257 10.776C0.73043 10.4839 1.06557 10.3378 1.44367 10.3378L19.799 10.3378L11.9619 2.50068C11.6697 2.20851 11.5236 1.86477 11.5236 1.46948C11.5236 1.07419 11.6697 0.730456 11.9619 0.438284C12.2541 0.146111 12.5978 2.48703e-05 12.9931 2.49125e-05C13.3884 2.48809e-05 13.7321 0.146111 14.0243 0.438284L24.3363 10.7503C24.6284 11.0424 24.7745 11.3862 24.7745 11.7815C24.7745 12.1767 24.6284 12.5205 24.3363 12.8127L14.0243 23.1246C13.7321 23.4168 13.3884 23.5629 12.9931 23.5629C12.5978 23.5629 12.2541 23.4168 11.9619 23.1246C11.6697 22.8325 11.5236 22.4887 11.5236 22.0934C11.5236 21.6981 11.6697 21.3544 11.9619 21.0622L19.799 13.2251Z" />
                            </svg>
                          </div>
                        </a>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            </motion.div>
          </div>
        </motion.section>

        <DecorativeLine className="my-20" variant="left-red-right-gold" />

        {/* Features / Game Modes Section */}
        <motion.section
          id="features"
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, amount: 0.3 }}
          variants={staggerContainer}
          className="py-20"
        >
          <div className="container mx-auto px-6 lg:px-12 xl:px-24">
            <div className="text-center max-w-4xl mx-auto mb-16">
              <motion.h2
                variants={fadeInUp}
                className="text-4xl lg:text-[55px] font-bold leading-tight mb-6 font-['Orbitron']"
              >
                <span className="text-white">Choose Your </span>
                <span className="text-[#F0B71F]">
                  Path
                </span>
              </motion.h2>
              <motion.p variants={fadeInUp} className="text-[#999] text-lg leading-8">
                Queue ranked PvP, challenge friends in private rooms, train in practice mode,
                or spectate live matches from the arena feed.
              </motion.p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-8 max-w-6xl mx-auto">
              {[
                {
                  title: 'Quick Match',
                  description:
                    'Jump into ranked PvP with auto-matchmaking. Pick a fighter, then trade turn-based moves while managing HP, energy, and guard.',
                  icon: (
                    <svg width="31" height="43" viewBox="0 0 31 43" fill="none">
                      <path
                        d="M17.25 26.8333V15.3333H22.0417V11.5H17.25V0H30.6667V11.5H25.875V15.3333H30.6667V26.8333H17.25ZM0 42.1667V30.6667H4.79167V26.8333H0V15.3333H4.79167V11.5H0V0H13.4167V11.5H8.625V15.3333H13.4167V26.8333H8.625V30.6667H13.4167V42.1667H0Z"
                        fill="url(#paint0_vb)"
                      />
                      <defs>
                        <linearGradient
                          id="paint0_vb"
                          x1="30.6667"
                          y1="37.0676"
                          x2="0"
                          y2="37.0676"
                        >
                          <stop stopColor="#F0B71F" />
                          <stop offset="1" stopColor="#E03609" />
                        </linearGradient>
                      </defs>
                    </svg>
                  ),
                },
                {
                  title: 'Power Surge',
                  description:
                    'Each round begins with a Power Surge pick that modifies combat. In private rooms, surge and move commitments run through a hidden commit/reveal flow.',
                  icon: (
                    <svg width="40" height="39" viewBox="0 0 40 39" fill="none">
                      <path
                        d="M33.1583 13.225L39.2917 19.3583L36.6083 22.0417L30.475 15.9083C29.8042 16.2917 29.0854 16.6111 28.3188 16.8667C27.5521 17.1222 26.7375 17.25 25.875 17.25C23.4792 17.25 21.4427 16.4115 19.7656 14.7344C18.0885 13.0573 17.25 11.0208 17.25 8.625C17.25 6.22917 18.0885 4.19271 19.7656 2.51562C21.4427 0.838542 23.4792 0 25.875 0C28.2708 0 30.3073 0.838542 31.9844 2.51562C33.6615 4.19271 34.5 6.22917 34.5 8.625C34.5 9.4875 34.3722 10.3021 34.1167 11.0688C33.8611 11.8354 33.5417 12.5542 33.1583 13.225ZM25.875 13.4167C27.2167 13.4167 28.3507 12.9535 29.2771 12.0271C30.2035 11.1007 30.6667 9.96667 30.6667 8.625C30.6667 7.28333 30.2035 6.14931 29.2771 5.22292C28.3507 4.29653 27.2167 3.83333 25.875 3.83333C24.5333 3.83333 23.3993 4.29653 22.4729 5.22292C21.5465 6.14931 21.0833 7.28333 21.0833 8.625C21.0833 9.96667 21.5465 11.1007 22.4729 12.0271C23.3993 12.9535 24.5333 13.4167 25.875 13.4167ZM3.83333 38.3333C2.77917 38.3333 1.87674 37.958 1.12604 37.2073C0.375347 36.4566 0 35.5542 0 34.5V7.66667C0 6.6125 0.375347 5.71007 1.12604 4.95937C1.87674 4.20868 2.77917 3.83333 3.83333 3.83333H14.375C14.0236 4.63194 13.784 5.45451 13.6563 6.30104C13.5285 7.14757 13.4646 7.98611 13.4646 8.81667C13.4646 12.2986 14.6944 15.2056 17.1542 17.5375C19.6139 19.8694 22.5368 21.0354 25.9229 21.0354C26.5299 21.0354 27.1368 20.9955 27.7438 20.9156C28.3507 20.8358 28.9736 20.7 29.6125 20.5083L34.5 25.3958V34.5C34.5 35.5542 34.1247 36.4566 33.374 37.2073C32.6233 37.958 31.7208 38.3333 30.6667 38.3333H3.83333Z"
                        fill="url(#paint1_vb)"
                      />
                      <defs>
                        <linearGradient
                          id="paint1_vb"
                          x1="39.2917"
                          y1="33.6978"
                          x2="0"
                          y2="33.6978"
                        >
                          <stop stopColor="#F0B71F" />
                          <stop offset="1" stopColor="#E03609" />
                        </linearGradient>
                      </defs>
                    </svg>
                  ),
                },
                {
                  title: 'Practice Mode',
                  description:
                    'Hone your skills against AI opponents. Learn matchup timing and move interactions before stepping into ranked or private PvP.',
                  icon: (
                    <svg width="35" height="35" viewBox="0 0 35 35" fill="none">
                      <path
                        d="M3.83333 34.5C3.29028 34.5 2.83507 34.3163 2.46771 33.949C2.10035 33.5816 1.91667 33.1264 1.91667 32.5833V30.6667H0V23C0 22.4569 0.183681 22.0017 0.551042 21.6344C0.918403 21.267 1.37361 21.0833 1.91667 21.0833H3.83333V7.66667C3.83333 5.55833 4.58403 3.75347 6.08542 2.25208C7.58681 0.750695 9.39167 0 11.5 0C13.6083 0 15.4132 0.750695 16.9146 2.25208C18.416 3.75347 19.1667 5.55833 19.1667 7.66667V26.8333C19.1667 27.8875 19.542 28.7899 20.2927 29.5406C21.0434 30.2913 21.9458 30.6667 23 30.6667C24.0542 30.6667 24.9566 30.2913 25.7073 29.5406C26.458 28.7899 26.8333 27.8875 26.8333 26.8333V13.4167H24.9167C24.3736 13.4167 23.9184 13.233 23.551 12.8656C23.1837 12.4983 23 12.0431 23 11.5V3.83333H24.9167V1.91667C24.9167 1.37361 25.1003 0.918403 25.4677 0.551042C25.8351 0.183681 26.2903 0 26.8333 0H30.6667C31.2097 0 31.6649 0.183681 32.0323 0.551042C32.3997 0.918403 32.5833 1.37361 32.5833 1.91667V3.83333H34.5V11.5C34.5 12.0431 34.3163 12.4983 33.949 12.8656C33.5816 13.233 33.1264 13.4167 32.5833 13.4167H30.6667V26.8333C30.6667 28.9417 29.916 30.7465 28.4146 32.2479C26.9132 33.7493 25.1083 34.5 23 34.5C20.8917 34.5 19.0868 33.7493 17.5854 32.2479C16.084 30.7465 15.3333 28.9417 15.3333 26.8333V7.66667C15.3333 6.6125 14.958 5.71007 14.2073 4.95937C13.4566 4.20868 12.5542 3.83333 11.5 3.83333C10.4458 3.83333 9.5434 4.20868 8.79271 4.95937C8.04201 5.71007 7.66667 6.6125 7.66667 7.66667V21.0833H9.58333C10.1264 21.0833 10.5816 21.267 10.949 21.6344C11.3163 22.0017 11.5 22.4569 11.5 23V30.6667H9.58333V32.5833C9.58333 33.1264 9.39965 33.5816 9.03229 33.949C8.66493 34.3163 8.20972 34.5 7.66667 34.5H3.83333Z"
                        fill="url(#paint2_vb)"
                      />
                      <defs>
                        <linearGradient
                          id="paint2_vb"
                          x1="34.5"
                          y1="30.3281"
                          x2="0"
                          y2="30.3281"
                        >
                          <stop stopColor="#F0B71F" />
                          <stop offset="1" stopColor="#E03609" />
                        </linearGradient>
                      </defs>
                    </svg>
                  ),
                },
              ].map((service, index) => (
                <motion.div variants={fadeInUp} key={index}>
                  <div className="flex gap-6">
                    <div className="w-20 h-20 rounded-[11px] border-2 border-[#F0B71F] flex items-center justify-center flex-shrink-0">
                      {service.icon}
                    </div>
                    <div className="flex-1">
                      <h3 className="text-2xl lg:text-3xl font-medium mb-4 text-white font-['Orbitron']">
                        {service.title}
                      </h3>
                      <p className="text-[#999] text-lg leading-8">{service.description}</p>
                    </div>
                  </div>
                </motion.div>
              ))}
            </div>
          </div>
        </motion.section>

        <DecorativeLine className="my-20" variant="left-red-right-gold" />

        {/* Portal Section */}
        <motion.section
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, amount: 0.3 }}
          variants={staggerContainer}
          className="py-20"
        >
          <div className="container mx-auto px-6 lg:px-12 xl:px-24">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 items-center">
              <motion.div variants={fadeInUp}>
                {/* Chain graphic with background image */}
                <div className="w-full aspect-square max-w-[500px] mx-auto rounded-2xl shadow-2xl shadow-[#E03609]/20 border border-[#F0B71F]/20 overflow-hidden relative">
                  {/* Background image */}
                  <div className="absolute inset-0">
                    <img
                      src="/assets/3.webp"
                      alt="Contract"
                      className="w-full h-full object-cover"
                    />
                  </div>
                  {/* Overlay gradient */}
                  <div className="absolute inset-0 bg-gradient-to-br from-[#0a0a1a]/90 to-[#1a0a2e]/80" />
                  <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_50%,rgba(240,183,31,0.1),transparent_60%)]" />
                  
                  {/* Contract code overlay */}
                  <div className="text-center relative z-10 p-8 flex items-center justify-center h-full">
                    <div className="space-y-3">
                      {['start_game()', 'commit_move()', 'reveal_proof()', 'end_game()'].map(
                        (fn, i) => (
                          <div
                            key={i}
                            className="px-4 py-2 rounded border border-[#F0B71F]/30 bg-[#F0B71F]/5 text-[#F0B71F] font-mono text-sm backdrop-blur-sm"
                          >
                            {fn}
                          </div>
                        ),
                      )}
                      <p className="text-[#999] text-xs mt-6 font-['Orbitron']">SOROBAN CONTRACT</p>
                    </div>
                  </div>
                </div>
              </motion.div>

              <motion.div variants={fadeInUp}>
                <h2 className="text-4xl lg:text-[55px] font-bold leading-tight mb-8 font-['Orbitron']">
                  <span className="text-white">Your </span>
                  <span className="text-[#F0B71F]">
                    Portal to
                  </span>
                  <span className="text-white"> Glory</span>
                </h2>
                <p className="text-[#999] text-lg leading-8 mb-12">
                  Your matches run with server-synced combat and Stellar-backed game lifecycle events,
                  with private-room commitments verified before resolution. Bring your strategy,
                  then prove it in the arena.
                </p>

                <div className="flex flex-col sm:flex-row gap-4">
                  <a href="/play">
                    <motion.div whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }}>
                      <button
                        className="w-full sm:w-auto text-white border-0 hover:opacity-90 font-['Orbitron'] text-base sm:text-lg px-6 py-3 rounded-lg"
                        style={{ background: 'linear-gradient(90deg, #F0B71F, #E03609)' }}
                      >
                        Enter Arena
                      </button>
                    </motion.div>
                  </a>
                  <a href="#faq">
                    <motion.div whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }}>
                      <button className="w-full sm:w-auto border border-[#F0B71F] text-[#F0B71F] hover:bg-[#F0B71F]/10 font-['Orbitron'] text-base sm:text-lg px-6 py-3 rounded-lg bg-transparent">
                        Game FAQ
                      </button>
                    </motion.div>
                  </a>
                </div>
              </motion.div>
            </div>
          </div>
        </motion.section>

        <DecorativeLine className="my-20" variant="left-red-right-gold" />

        {/* FAQs Section */}
        <motion.section
          id="faq"
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, amount: 0.3 }}
          variants={staggerContainer}
          className="py-20"
        >
          <div className="container mx-auto px-6 lg:px-12 xl:px-24">
            <div className="text-center max-w-4xl mx-auto mb-16">
              <motion.h2
                variants={fadeInUp}
                className="text-4xl lg:text-[55px] font-bold leading-tight mb-6 font-['Orbitron']"
              >
                <span className="text-white">Frequently Asked </span>
                <span className="text-[#F0B71F]">
                  Questions
                </span>
              </motion.h2>
              <motion.p variants={fadeInUp} className="text-[#999] text-lg leading-8">
                Everything you need to know about Veilstar Brawl — the ZK-powered fighting game on
                Stellar.
              </motion.p>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 max-w-6xl mx-auto">
              {[
                {
                  number: '01.',
                  question: 'What makes Veilstar Brawl special?',
                  answer:
                    'Veilstar Brawl combines a turn-based 1v1 combat system (punch, kick, block, special) with Power Surge modifiers, energy/guard management, and private-room hidden planning backed by Noir proof checks.',
                },
                {
                  number: '02.',
                  question: 'How do the ZK proofs work?',
                  answer:
                    'In private-room flow, players commit hidden selections first, then reveal. Noir-based verification checks the reveal matches the commitment before full turn resolution is finalized.',
                },
                {
                  number: '03.',
                  question: 'What blockchain is this built on?',
                  answer:
                    'Veilstar Brawl runs on Stellar\'s Soroban smart contracts with Protocol 25 (X-Ray) ZK primitives — BN254 curve operations and Poseidon hashes — enabling on-chain proof verification.',
                },
                {
                  number: '04.',
                  question: 'Do I need a wallet to play?',
                  answer:
                    'Practice mode can be played without wallet transactions. For matchmaking, private rooms, and signed match actions, use a Stellar-compatible wallet (like Freighter) on Testnet.',
                },
              ].map((faq, index) => (
                <motion.div
                  variants={fadeInUp}
                  key={index}
                  className="pb-8"
                  style={{ borderBottom: '1px solid', borderImage: 'linear-gradient(270deg, #F0B71F, #E03609) 1' }}
                >
                  <div className="flex gap-6">
                    <span
                      className="text-5xl font-medium leading-tight font-['Orbitron'] text-[#F0B71F]"
                    >
                      {faq.number}
                    </span>
                    <div className="flex-1">
                      <h3 className="text-2xl font-semibold mb-4 text-white font-['Orbitron']">
                        {faq.question}
                      </h3>
                      <p className="text-[#999] text-lg leading-8">{faq.answer}</p>
                    </div>
                  </div>
                </motion.div>
              ))}
            </div>
          </div>
        </motion.section>

        <DecorativeLine className="my-20" variant="left-red-right-gold" />
      </div>
    </LandingLayout>
  );
}
