import { useState } from 'react';

export default function LandingHeader() {
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);

  const scrollToSection = (id: string) => {
    setIsMobileMenuOpen(false);
    const element = document.getElementById(id);
    if (element) {
      element.scrollIntoView({ behavior: 'smooth' });
    }
  };

  return (
    <header className="fixed top-0 left-0 right-0 z-50 bg-[#010101]/80 backdrop-blur-md border-b border-white/5">
      <nav className="container mx-auto px-6 lg:px-12 xl:px-24 py-4 flex items-center justify-between">
        {/* Logo */}
        <a href="/" className="flex items-center gap-3 group">
          <img
            src="/logo.webp"
            alt="Veilstar Brawl Logo"
            className="w-10 h-10 object-contain group-hover:scale-110 transition-transform duration-300"
          />
          <span
            className="text-2xl font-bold font-['Orbitron'] bg-clip-text text-transparent"
            style={{ backgroundImage: 'linear-gradient(90deg, #F0B71F, #E03609)' }}
          >
            Veilstar Brawl
          </span>
        </a>

        {/* Desktop Navigation */}
        <div className="hidden md:flex items-center gap-8 text-sm font-medium font-['Orbitron'] tracking-wide">
          <button
            onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
            className="text-white hover:text-[#F0B71F] transition-colors bg-transparent border-none p-0"
          >
            HOME
          </button>
          <button
            onClick={() => scrollToSection('features')}
            className="text-white hover:text-[#F0B71F] transition-colors bg-transparent border-none p-0"
          >
            FEATURES
          </button>
          <a
            href="#zk"
            onClick={(e) => {
              e.preventDefault();
              scrollToSection('zk');
            }}
            className="text-white hover:text-[#F0B71F] transition-colors"
          >
            ZK PROOFS
          </a>
          <a
            href="#faq"
            onClick={(e) => {
              e.preventDefault();
              scrollToSection('faq');
            }}
            className="text-white hover:text-[#F0B71F] transition-colors"
          >
            FAQ
          </a>
        </div>

        {/* CTA Button */}
        <div className="hidden md:block">
          <a href="/play">
            <button
              className="text-white border-0 font-bold text-sm px-6 h-10 rounded-lg font-['Orbitron'] hover:shadow-[0_0_20px_rgba(240,183,31,0.3)] transition-all duration-300"
              style={{ background: 'linear-gradient(90deg, #F0B71F, #E03609)' }}
            >
              PLAY NOW
            </button>
          </a>
        </div>

        {/* Mobile Menu Button */}
        <button
          onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
          className="md:hidden text-white p-2 hover:text-[#00F0FF] transition-colors bg-transparent border-none"
        >
          {isMobileMenuOpen ? (
            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          ) : (
            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          )}
        </button>
      </nav>

      {/* Mobile Menu */}
      {isMobileMenuOpen && (
        <div className="md:hidden fixed inset-0 top-[73px] bg-[#010101]/95 backdrop-blur-xl z-40 p-6 flex flex-col gap-6">
          <button
            onClick={() => {
              window.scrollTo({ top: 0, behavior: 'smooth' });
              setIsMobileMenuOpen(false);
            }}
            className="text-lg font-bold font-['Orbitron'] text-white text-left bg-transparent border-none p-0"
          >
            HOME
          </button>
          <button
            onClick={() => scrollToSection('features')}
            className="text-lg font-bold font-['Orbitron'] text-white text-left bg-transparent border-none p-0"
          >
            FEATURES
          </button>
          <button
            onClick={() => scrollToSection('zk')}
            className="text-lg font-bold font-['Orbitron'] text-white text-left bg-transparent border-none p-0"
          >
            ZK PROOFS
          </button>
          <button
            onClick={() => scrollToSection('faq')}
            className="text-lg font-bold font-['Orbitron'] text-white text-left bg-transparent border-none p-0"
          >
            FAQ
          </button>

          <div className="h-px bg-white/10 my-2" />

          <a href="/play" onClick={() => setIsMobileMenuOpen(false)}>
            <button
              className="w-full text-white border-0 font-bold text-lg py-4 font-['Orbitron'] rounded-lg"
              style={{ background: 'linear-gradient(90deg, #F0B71F, #E03609)' }}
            >
              PLAY NOW
            </button>
          </a>
        </div>
      )}
    </header>
  );
}
